#!/usr/bin/env python3
"""打包扩展为可上传/侧载的 zip 与 crx（仅运行时文件，排除 test/tools/README）。

产出四个包：
  dist/novel-reader-v<版本>.zip          —— Chrome / Edge / Android Chromium（Kiwi、Edge Canary）
  dist/novel-reader-v<版本>-firefox.zip  —— Firefox 桌面与 Android（注入 background.scripts 事件页字段，
                                            该字段会让 Chrome 报 manifest 警告，故从主包剥离）
  dist/novel-yuedu-v<版本>.xpi           —— 与 firefox.zip 同内容，AMO 提交/自签用的规范扩展名
  dist/novel-yuedu-v<版本>.crx           —— CRX3 签名包，安卓 Kiwi / Edge Canary 侧载用

CRX 签名私钥不放在项目目录内（gitignore 只防 git，防不了整目录压缩/网盘同步外带泄密）：
  - 查找顺序：环境变量 NR_CRX_KEY → ~/.config/novel-yuedu/crx-private-key.pem
    → tools/crx-private-key.pem（旧位置，仅过渡兼容并提示迁移）；
  - 扩展 ID 由公钥派生，换私钥 = 换扩展 ID，安卓侧载老用户更新会被视为新扩展；
  - 找不到私钥时不再静默生成：--gen-key 显式生成新钥（换 ID 须让老用户重装）。
"""
import hashlib
import json
import os
import struct
import subprocess
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
manifest_path = ROOT / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
version = manifest["version"]
dist = ROOT / "dist"
dist.mkdir(exist_ok=True)

CRX_KEY_LEGACY = ROOT / "tools" / "crx-private-key.pem"


def primary_key_path() -> Path:
    """私钥的应存放位置：显式指定 NR_CRX_KEY 时用它，否则用户配置目录（项目目录之外）。"""
    env = os.environ.get("NR_CRX_KEY")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".config" / "novel-yuedu" / "crx-private-key.pem"


def resolve_crx_key():
    """按 NR_CRX_KEY → 用户配置目录 → 旧项目内路径 查找私钥；找不到返回 None。

    显式设置的 NR_CRX_KEY 不存在时直接返回 None（视为缺失，交由调用方报错或
    --gen-key 生成），避免拼错路径时静默回落到别的钥匙导致扩展 ID 悄悄改变。
    """
    p = primary_key_path()
    if p.exists():
        return p
    if CRX_KEY_LEGACY.exists():
        print(f"提示：正在使用旧位置私钥 {CRX_KEY_LEGACY}，请尽快移至 {p}（密钥不应留在项目目录内）")
        return CRX_KEY_LEGACY
    return None

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
                # manifest 是改写后的内容（Firefox 变体不同），不能直接 z.write；但时间戳必须
                # 取自源文件而非当前时刻，否则每次打包容器字节都变、同一源码产出不同校验和。
                zi = zipfile.ZipInfo("manifest.json", time.localtime(manifest_path.stat().st_mtime)[:6])
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi.external_attr = 0o644 << 16
                z.writestr(zi, json.dumps(manifest_obj, ensure_ascii=False, indent=2))
            else:
                z.write(f, arc)
    print(f"{out.relative_to(ROOT)}  {out.stat().st_size} bytes（{out.stat().st_size / 1024:.1f} KB）")
    return out


# Chrome / Chromium（含 Android：Kiwi、Edge Canary）
chrome_zip = build(f"novel-reader-v{version}.zip", manifest)

# Firefox（桌面 + Android）：注入事件页 background（service-worker.js 无其他依赖）
ff_manifest = dict(manifest)
ff_manifest["background"] = {
    "scripts": ["src/background/service-worker.js"],
}
build(f"novel-reader-v{version}-firefox.zip", ff_manifest)

# AMO 提交用：与 firefox 包同内容，仅扩展名换成规范的 .xpi（Firefox 加载/自签都认它）
build(f"novel-yuedu-v{version}.xpi", ff_manifest)


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
    key = resolve_crx_key()
    if key is None:
        if "--gen-key" in sys.argv:
            key = primary_key_path()
            key.parent.mkdir(parents=True, exist_ok=True)
            _openssl("genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(key))
            key.chmod(0o600)
            print(f"已生成新签名私钥 {key}")
            print("注意：扩展 ID 已随之变更，安卓侧载老用户更新会被视为新扩展，需按 README 重新安装")
        else:
            sys.exit(
                "错误：未找到 CRX 签名私钥。\n"
                f"  查找顺序：环境变量 NR_CRX_KEY → {primary_key_path()} → {CRX_KEY_LEGACY}（旧位置）\n"
                "  扩展 ID 由私钥派生：要沿用历史 ID 请从备份恢复私钥到上述位置；\n"
                "  确需换 ID（安卓老用户须重装、丢本地进度）请显式使用 --gen-key 生成新钥。"
            )

    pub_der = _openssl("rsa", "-in", str(key), "-pubout", "-outform", "DER")
    crx_id = hashlib.sha256(pub_der).digest()[:16]
    signed_data = _pb_field(1, crx_id)  # protobuf SignedData{ crx_id = 1 }
    signature = _openssl("dgst", "-sha256", "-sign", str(key), stdin_bytes=signed_data)
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
print(f"完成：Chrome 主包 + Firefox 变体包 + AMO 提交 XPI + 安卓侧载 CRX3（自校验通过，扩展 ID {ext_id}）")
