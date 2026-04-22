#!/usr/bin/env python3
"""Generate PWA icons for Азбука.

Renders the app icon at multiple sizes using PIL.
Design: deep indigo→crimson gradient with large Cyrillic 'Я' centered,
and a small yellow accent circle — echoes the SVG master.
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
OUT.mkdir(parents=True, exist_ok=True)

# Candidate fonts — first found wins
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Georgia.ttf",
    "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]

def find_font(size: int):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def lerp(a, b, t):
    return int(a + (b - a) * t)


def make_gradient(size: int) -> Image.Image:
    """Diagonal gradient indigo → crimson."""
    c1 = (26, 20, 64)     # deep indigo
    c2 = (58, 31, 107)    # mid purple
    c3 = (192, 57, 43)    # crimson
    img = Image.new("RGB", (size, size), c1)
    px = img.load()
    for y in range(size):
        for x in range(size):
            # diagonal parameter 0..1
            t = (x + y) / (2 * (size - 1))
            if t < 0.55:
                k = t / 0.55
                r = lerp(c1[0], c2[0], k); g = lerp(c1[1], c2[1], k); b = lerp(c1[2], c2[2], k)
            else:
                k = (t - 0.55) / 0.45
                r = lerp(c2[0], c3[0], k); g = lerp(c2[1], c3[1], k); b = lerp(c2[2], c3[2], k)
            px[x, y] = (r, g, b)
    return img


def rounded_mask(size: int, radius_ratio: float = 0.22) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    r = int(size * radius_ratio)
    d.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=r, fill=255)
    return mask


def render_icon(size: int, rounded: bool = True, bg_fallback=None) -> Image.Image:
    base = make_gradient(size).convert("RGBA")

    # Soft top-left glow
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for i in range(6):
        alpha = 18 - i * 2
        if alpha <= 0:
            break
        inset = int(size * 0.02 * i)
        gd.ellipse(
            [(int(size * 0.05) - inset, int(size * 0.02) - inset),
             (int(size * 0.75) + inset, int(size * 0.55) + inset)],
            fill=(255, 255, 255, alpha),
        )
    glow = glow.filter_gaussian = glow  # placeholder (no blur dep); simple layer
    base = Image.alpha_composite(base, glow)

    draw = ImageDraw.Draw(base)

    # The big Я
    letter = "Я"
    font = find_font(int(size * 0.7))
    # measure
    bbox = draw.textbbox((0, 0), letter, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    # position accounting for bbox offset
    x = (size - tw) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1] - int(size * 0.01)

    # Subtle shadow
    shadow_offset = max(2, size // 120)
    draw.text((x + shadow_offset, y + shadow_offset), letter, font=font, fill=(0, 0, 0, 90))
    # Main glyph in warm ivory
    draw.text((x, y), letter, font=font, fill=(253, 246, 227, 255))

    # Yellow accent dot top-right
    dot_r = max(3, int(size * 0.045))
    cx = int(size * 0.79)
    cy = int(size * 0.24)
    draw.ellipse([(cx - dot_r, cy - dot_r), (cx + dot_r, cy + dot_r)], fill=(241, 196, 15, 255))

    if rounded:
        mask = rounded_mask(size)
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(base, (0, 0), mask)
        return out
    else:
        # Flat square, no transparency (for apple-touch-icon-precomposed)
        flat = Image.new("RGB", (size, size), bg_fallback or (26, 20, 64))
        flat.paste(base.convert("RGB"), (0, 0))
        return flat


def save(img: Image.Image, name: str):
    path = OUT / name
    img.save(path, format="PNG", optimize=True)
    print(f"  wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")


def main():
    # Standard PWA icons (transparent rounded)
    for size in (192, 512):
        img = render_icon(size, rounded=True)
        save(img, f"icon-{size}.png")

    # Maskable icon — needs 20% safe-zone padding; we already have generous padding
    for size in (192, 512):
        img = render_icon(size, rounded=False)
        save(img, f"icon-maskable-{size}.png")

    # Apple touch icon (180×180, square, no transparency — iOS applies its own mask)
    apple = render_icon(180, rounded=False)
    save(apple, "apple-touch-icon.png")

    # Favicon sizes
    for size in (32, 16):
        img = render_icon(size, rounded=True)
        save(img, f"favicon-{size}.png")

    # Combined .ico (use 32px png as base)
    ico_src = render_icon(64, rounded=True)
    ico_path = OUT.parent / "favicon.ico"
    ico_src.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print(f"  wrote {ico_path.relative_to(ROOT)}")

    print("done.")


if __name__ == "__main__":
    main()
