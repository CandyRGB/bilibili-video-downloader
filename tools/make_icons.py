"""生成扩展图标（不依赖 Pillow）：圆角渐变底 + 白色下载箭头，4x4 超采样抗锯齿。"""
import zlib, struct, os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
os.makedirs(OUT, exist_ok=True)

TOP = (243, 125, 158)
BOT = (208, 82, 118)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def inside_rounded(x, y, w, h, r):
    # 归一化坐标 0..1，圆角半径 r 同为归一化单位
    px, py = x * w, y * h
    rx = min(r, w / 2)
    ry = min(r, h / 2)
    cx = min(max(px, rx), w - rx)
    cy = min(max(py, ry), h - ry)
    return (px - cx) ** 2 + (py - cy) ** 2 <= rx * rx


def in_arrow(x, y):
    # 竖杆
    if 0.435 <= x <= 0.565 and 0.20 <= y <= 0.545:
        return True
    # 三角箭头
    if 0.545 <= y <= 0.735:
        t = (y - 0.545) / (0.735 - 0.545)
        half = 0.245 * (1 - t)
        if abs(x - 0.5) <= half:
            return True
    # 底部承托
    if 0.775 <= y <= 0.845 and 0.215 <= x <= 0.785:
        return True
    return False


def render(size):
    ss = 4
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            cov_bg = 0
            cov_ar = 0
            R = G = B = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size
                    if in_arrow(x, y):
                        cov_ar += 1
                    elif inside_rounded(x, y, 1.0, 1.0, 0.22):
                        cov_bg += 1
                        c = lerp(TOP, BOT, y)
                        R += c[0]
                        G += c[1]
                        B += c[2]
            n = ss * ss
            total = cov_bg + cov_ar
            if total == 0:
                row += bytes((0, 0, 0, 0))
                continue
            a = round(255 * total / n)
            if cov_bg:
                br, bg, bb = R / cov_bg, G / cov_bg, B / cov_bg
            else:
                br = bg = bb = 0
            # 箭头覆盖在白底上做混合
            w = cov_ar / total
            r = round(br * (1 - w) + 255 * w)
            g = round(bg * (1 - w) + 255 * w)
            b = round(bb * (1 - w) + 255 * w)
            row += bytes((r, g, b, a))
        rows.append(bytes(row))
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


for s in (16, 32, 48, 128):
    p = os.path.join(OUT, f"icon{s}.png")
    with open(p, "wb") as f:
        f.write(render(s))
    print("generated", p, os.path.getsize(p), "bytes")
