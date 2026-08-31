#!/usr/bin/env python3
"""打包扩展为可上传/侧载的 zip（仅运行时文件，排除 test/tools/README）。

产出两个包：
  dist/novel-reader-v<版本>.zip          —— Chrome / Edge / Android Chromium（Kiwi、Edge Canary）
  dist/novel-reader-v<版本>-firefox.zip  —— Firefox 桌面与 Android（注入 background.scripts 事件页字段，
                                            该字段会让 Chrome 报 manifest 警告，故从主包剥离）
"""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
manifest_path = ROOT / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
version = manifest["version"]
dist = ROOT / "dist"
dist.mkdir(exist_ok=True)

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
build(f"novel-reader-v{version}.zip", manifest)

# Firefox（桌面 + Android）：注入事件页 background，随 scripts 先载入域名表
ff_manifest = dict(manifest)
ff_manifest["background"] = {
    "scripts": ["src/background/ad-domains.js", "src/background/service-worker.js"],
}
build(f"novel-reader-v{version}-firefox.zip", ff_manifest)
print("完成：Chrome 主包 + Firefox 变体包")
