#!/usr/bin/env python3
"""打包扩展为可上传/侧载的 zip 与 crx（仅运行时文件，排除 test/tools/README）。

产出三个包：
  dist/novel-reader-v<版本>.zip          —— Chrome / Edge / Android Chromium（Kiwi、Edge Canary）
  dist/novel-reader-v<版本>-firefox.zip  —— Firefox 桌面与 Android（注入 background.scripts 事件页字段，
                                            该字段会让 Chrome 报 manifest 警告，故从主包剥离）
  dist/novel-yuedu-v<版本>.crx           —— CRX3 签名包，安卓 Kiwi / Edge Canary 侧载用

CRX 签名私钥固定为 tools/crx-private-key.pem（gitignore 不入库）：
  - 扩展 ID 由公钥派生，换私钥 = 换扩展 ID，安卓侧载老用户更新会被视为新扩展；
  - 私钥缺失时自动生成（新机器 clone 后首次打包），并在输出中提示 ID 已变。
"""
import hashlib
import json
import struct
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
manifest_path = ROOT / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
version = manifest["version"]
dist = ROOT / "dist"
dist.mkdir(exist_ok=True)

CRX_KEY = ROOT / "tools" / "crx-private-key.pem"

INCLUDE = ["manifest.json", "rules", "src", "icons"]
EXCLUDE_NAMES = {".DS_Store", "__pycache__"}


def iter_files():
    for name in INCLUDE:
        p = ROOT / name
        if p.is_file():
            yield p, p.name
            continue
        for f in sorted(p.rglob("*")):
            if not f.is_file():
                continue
            if f.name in EXCLUDE_NAMES or "__pycache__" in f.parts:
                continue
            yield f, f.relative_to(ROOT).as_posix()


def build(out_name, manifest_obj):
    out = dist / out_name
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f, arc in iter_files():
            if f == manifest_path:
                z.writestr("manifest.json", json.dumps(manifest_obj, ensure_ascii=False, indent=2))
            else:
                z.write(f, arc)
    print(f"{out.relative_to(ROOT)}  {out.stat().st_size} bytes（{out.stat().st_size / 1024:.1f} KB）")
    return out


# Chrome / Chromium（含 Android：Kiwi、Edge Canary）
chrome_zip = build(f"novel-reader-v{version}.zip", manifest)

# Firefox（桌面 + Android）：注入事件页 background，随 scripts 先载入域名表
ff_manifest = dict(manifest)
ff_manifest["background"] = {
    "scripts": ["src/background/ad-domains.js", "src/background/service-worker.js"],
}
build(f"novel-reader-v{version}-firefox.zip", ff_manifest)


# ---------------- CRX3（安卓侧载） ----------------

def _varint(n: int) -> bytes:
    out = b""
    while True:
        b7 = n & 0x7F
        n >>= 7
        out += bytes([b7 | (0x80 if n else 0)])
        if not n:
            return out


def _pb_field(num: int, payload: bytes) -> bytes:
    return _varint((num << 3) | 2) + _varint(len(payload)) + payload


def _openssl(*args, stdin_bytes: bytes = b"") -> bytes:
    r = subprocess.run(["openssl", *args], input=stdin_bytes, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"openssl {' '.join(args[:2])} 失败: {r.stderr.decode(errors='replace')[:200]}")
    return r.stdout


def build_crx(zip_path: Path) -> str:
    """对 zip 内容做 CRX3 签名（协议与 Chromium crx_file.cc 一致：
    SHA256/RSA PKCS#1v1.5 签名覆盖 SignedData{crx_id}，公钥 DER 与签名放入
    CrxFileHeader.sha256_with_rsa，扩展 ID = SHA256(公钥 DER) 前 16 字节）。
    返回扩展 ID。"""
    if not CRX_KEY.exists():
        _openssl("genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(CRX_KEY))
        CRX_KEY.chmod(0o600)
        print(f"已生成新签名私钥 {CRX_KEY.relative_to(ROOT)}（注意：扩展 ID 将与历史版本不同）")

    pub_der = _openssl("rsa", "-in", str(CRX_KEY), "-pubout", "-outform", "DER")
    crx_id = hashlib.sha256(pub_der).digest()[:16]
    signed_data = _pb_field(1, crx_id)  # protobuf SignedData{ crx_id = 1 }
    signature = _openssl("dgst", "-sha256", "-sign", str(CRX_KEY), stdin_bytes=signed_data)
    # protobuf AsymmetricKeyProof{ public_key = 1, signature = 2 }
    proof = _pb_field(1, pub_der) + _pb_field(2, signature)
    # protobuf CrxFileHeader{ sha256_with_rsa = 2 (repeated), signed_header_data = 10000 }
    header = _pb_field(2, proof) + _pb_field(10000, signed_data)

    out = dist / f"novel-yuedu-v{version}.crx"
    out.write_bytes(b"Cr24" + struct.pack("<II", 3, len(header)) + header + zip_path.read_bytes())
    ext_id = "".join("abcdefghijklmnop"[int(c, 16)] for c in crx_id.hex())
    print(f"{out.relative_to(ROOT)}  {out.stat().st_size} bytes（{out.stat().st_size / 1024:.1f} KB）  扩展 ID {ext_id}")
    return ext_id


def _read_varint(buf: bytes, i: int):
    v = 0
    s = 0
    while True:
        b = buf[i]
        i += 1
        v |= (b & 0x7F) << s
        if not b & 0x80:
            return v, i
        s += 7


def _pb_fields(msg: bytes):
    """迭代解析 protobuf 顶层 (field_number, wire_type, payload)；仅支持本格式用到的 wire type 2。"""
    i = 0
    while i < len(msg):
        tag, i = _read_varint(msg, i)
        ln, i = _read_varint(msg, i)
        yield tag >> 3, tag & 7, msg[i : i + ln]
        i += ln


def verify_crx(path: Path):
    """按 Chromium crx_file.cc 的安装校验逻辑自检：魔数/版本、头部 protobuf、
    签名覆盖 signed_header_data 可验通、crx_id 与公钥派生一致、载荷为合法 zip。"""
    data = path.read_bytes()
    assert data[:4] == b"Cr24", "CRX 魔数错误"
    ver, hdr_len = struct.unpack("<II", data[4:12])
    assert ver == 3, f"CRX 版本应为 3，实际 {ver}"
    header = data[12 : 12 + hdr_len]
    payload = data[12 + hdr_len :]

    proof_msg = None
    signed_data = None
    for num, wire, val in _pb_fields(header):
        if num == 2 and wire == 2:
            proof_msg = val
        elif num == 10000 and wire == 2:
            signed_data = val
    assert proof_msg and signed_data, "CRX 头部缺少签名证明或 SignedData"

    pub = sig = None
    for num, wire, val in _pb_fields(proof_msg):
        if num == 1 and wire == 2:
            pub = val
        elif num == 2 and wire == 2:
            sig = val
    assert pub and sig, "签名证明缺少公钥/签名"

    crx_id = None
    for num, wire, val in _pb_fields(signed_data):
        if num == 1 and wire == 2:
            crx_id = val
    assert crx_id == hashlib.sha256(pub).digest()[:16], "crx_id 与公钥派生值不一致"

    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".pub") as pf, tempfile.NamedTemporaryFile(suffix=".sig") as sf:
        pf.write(pub)
        pf.flush()
        sf.write(sig)
        sf.flush()
        r = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", pf.name, "-signature", sf.name],
            input=signed_data,
            capture_output=True,
        )
        assert r.returncode == 0 and b"Verified OK" in r.stdout, "CRX 头部签名验签失败"

    import io

    with zipfile.ZipFile(io.BytesIO(payload)) as z:
        assert "manifest.json" in z.namelist(), "CRX 载荷缺少 manifest.json"


ext_id = build_crx(chrome_zip)
verify_crx(dist / f"novel-yuedu-v{version}.crx")
print(f"完成：Chrome 主包 + Firefox 变体包 + 安卓侧载 CRX3（自校验通过，扩展 ID {ext_id}）")
