#!/usr/bin/env python3
"""纯 stdlib 生成占位扩展图标（紫底白色翻开书页），4x 超采样抗锯齿。"""
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"

BG = (79, 70, 229)     # indigo #4F46E5
BG_DARK = (60, 54, 190)  # 底部渐深，增加立体感
WHITE = (255, 255, 255)


def in_rounded_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def draw(px, py, size):
    """返回 (r,g,b)。坐标归一化到 0..1 处理。"""
    x = px / size
    y = py / size
    # 背景圆角方形
    if not in_rounded_rect(px, py, 1, 1, size - 1, size - 1, size * 0.22):
        return (0, 0, 0)
    # 翻开的书：左右两页 + 中缝
    page_r = size * 0.02
    left = in_rounded_rect(px, py, size * 0.22, size * 0.28, size * 0.485, size * 0.70, page_r)
    right = in_rounded_rect(px, py, size * 0.515, size * 0.28, size * 0.78, size * 0.70, page_r)
    if left or right:
        # 页面上的两行“文字”
        line_h = size * 0.035
        row = (py - size * 0.28) / (size * 0.42)
        if 0.22 < row < 0.36 or 0.55 < row < 0.69:
            return WHITE if px < size * 0.5 else WHITE
        return WHITE
    # 上下轻微明暗变化
    return BG_DARK if y > 0.75 else BG


def write_png(path, size):
    ss = 4
    rows = []
    for py in range(size):
        row = bytearray([0])
        for pxx in range(size):
            r = g = b = 0
            for sy in range(ss):
                for sx in range(ss):
                    c = draw(pxx + (sx + 0.5) / ss, py + (sy + 0.5) / ss, size)
                    r += c[0]
                    g += c[1]
                    b += c[2]
            n = ss * ss
            row += bytes((r // n, g // n, b // n, 255))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    ICON_DIR.mkdir(exist_ok=True)
    Path(path).write_bytes(png)
    print(f"icon{size}.png  {len(png)} bytes")


for s in (16, 48, 128):
    write_png(ICON_DIR / f"icon{s}.png", s)
