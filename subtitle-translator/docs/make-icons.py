"""生成扩展图标：深蓝圆角方块 + 白色「译」字。

用法（本机）：
  C:/Users/ray/AppData/Local/Programs/Python/Python311/python.exe docs/make-icons.py
按 4 倍超采样绘制再降采样，小尺寸下边缘才不毛糙。
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFont

SIZES = [16, 32, 48, 128]
SS = 4
BG = (24, 95, 165, 255)
FG = (255, 255, 255, 255)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")

FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
]


def load_font(px):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, px)
            except Exception:
                continue
    return None


def draw_one(size):
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = int(n * 0.24)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=radius, fill=BG)

    font = load_font(int(n * 0.62))
    if font is not None:
        box = d.textbbox((0, 0), "译", font=font)
        w = box[2] - box[0]
        h = box[3] - box[1]
        d.text(((n - w) / 2 - box[0], (n - h) / 2 - box[1]), "译", font=font, fill=FG)
    else:
        d.rounded_rectangle(
            [int(n * 0.22), int(n * 0.34), int(n * 0.78), int(n * 0.46)],
            radius=int(n * 0.06), fill=FG)
        d.rounded_rectangle(
            [int(n * 0.22), int(n * 0.56), int(n * 0.62), int(n * 0.68)],
            radius=int(n * 0.06), fill=FG)

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for s in SIZES:
        path = os.path.join(OUT, "icon%d.png" % s)
        draw_one(s).save(path, "PNG")
        print("wrote", os.path.normpath(path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
