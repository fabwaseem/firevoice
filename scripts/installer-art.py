"""Draws the installers' artwork from the app icon, in the app's colours and typeface (Urbanist).

    uv run --no-project --with pillow --with fonttools --with brotli python scripts/installer-art.py

Writes src-tauri/installer/ (committed; run again after changing the icon):
  nsis-sidebar.bmp   164 x 314  Windows setup: the welcome and finish pages' left panel
  nsis-header.bmp    150 x 57   Windows setup: the corner of every other page
  wix-dialog.bmp     493 x 312  Windows .msi: the welcome and finish dialogs (the image is the left part)
  wix-banner.bmp     493 x 58   Windows .msi: the top of every other dialog
  dmg-background.png 660 x 400  macOS .dmg: the window you drag FireVoice to Applications in
"""
import io
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "installer"
ICON = Image.open(ROOT / "src-tauri" / "icons" / "icon.png").convert("RGBA")

# the app's tokens (src/styles/globals.css)
INK = (17, 19, 24)
INK_2 = (58, 63, 75)
BG = (243, 244, 247)
WHITE = (255, 255, 255)
FIRE = (255, 90, 45)
FIRE_2 = (255, 138, 76)
DARK = (17, 19, 24)
DARK_2 = (32, 35, 44)


def font_bytes() -> bytes:
    """Urbanist (the variable font the app ships) as a plain TrueType font Pillow can read."""
    f = TTFont(ROOT / "node_modules" / "@fontsource-variable" / "urbanist" / "files" / "urbanist-latin-wght-normal.woff2")
    f.flavor = None
    buf = io.BytesIO()
    f.save(buf)
    return buf.getvalue()


FONT = font_bytes()


def urbanist(size: int, weight: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(io.BytesIO(FONT), size)
    try:
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def gradient(w: int, h: int, a, b) -> Image.Image:
    """A diagonal gradient from the top left (a) to the bottom right (b)."""
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = (x / max(w - 1, 1) + y / max(h - 1, 1)) / 2
            px[x, y] = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return img


def icon(size: int) -> Image.Image:
    return ICON.resize((size, size), Image.LANCZOS)


def centred_text(d: ImageDraw.ImageDraw, w: int, y: int, text: str, font, fill) -> None:
    l, _, r, _ = d.textbbox((0, 0), text, font=font)
    d.text(((w - (r - l)) / 2 - l, y), text, font=font, fill=fill)


def sidebar(w: int = 164, h: int = 314) -> Image.Image:
    """Dark panel: the icon, the name and a line under it, like the app's sign-in panel."""
    img = gradient(w, h, DARK_2, DARK)
    # a soft fire glow behind the icon
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((w / 2 - 44, 112 - 44, w / 2 + 44, 112 + 44), fill=(*FIRE, 90))
    img = Image.alpha_composite(img.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(24)))
    ic = icon(76)
    img.alpha_composite(ic, ((w - 76) // 2, 74))
    d = ImageDraw.Draw(img)
    centred_text(d, w, 166, "FireVoice", urbanist(24, 700), WHITE)
    centred_text(d, w, 200, "Voice studio", urbanist(12, 500), (176, 182, 196))
    centred_text(d, w, 216, "and dictation", urbanist(12, 500), (176, 182, 196))
    # a thin fire line at the bottom
    d.rectangle((0, h - 4, w, h), fill=FIRE)
    return img.convert("RGB")


def header(w: int = 150, h: int = 57) -> Image.Image:
    """White corner of the setup pages: the icon and the name."""
    img = Image.new("RGBA", (w, h), WHITE + (255,))
    s = 30
    img.alpha_composite(icon(s), (w - s - 92, (h - s) // 2))
    d = ImageDraw.Draw(img)
    f = urbanist(17, 700)
    _, t, _, b = d.textbbox((0, 0), "FireVoice", font=f)
    d.text((w - 88, (h - (b - t)) / 2 - t), "FireVoice", font=f, fill=INK)
    return img.convert("RGB")


def wix_dialog(w: int = 493, h: int = 312) -> Image.Image:
    """The MSI welcome dialog: its text sits on the right, so the art is a 164 px panel on the left, white elsewhere."""
    img = Image.new("RGB", (w, h), WHITE)
    img.paste(sidebar(164, h), (0, 0))
    return img


def wix_banner(w: int = 493, h: int = 58) -> Image.Image:
    """The MSI dialogs' top strip: their title is drawn on the left, so the icon sits at the right."""
    img = Image.new("RGBA", (w, h), WHITE + (255,))
    s = 38
    img.alpha_composite(icon(s), (w - s - 12, (h - s) // 2))
    d = ImageDraw.Draw(img)
    d.rectangle((0, h - 2, w, h), fill=(232, 234, 239))
    return img.convert("RGB")


def dmg(scale: int = 1) -> Image.Image:
    """The macOS disk image window: drag the app onto Applications (icons at 180,190 and 480,190 in tauri.conf.json)."""
    w, h = 660 * scale, 400 * scale
    img = Image.new("RGBA", (w, h), BG + (255,))
    d = ImageDraw.Draw(img)
    centred_text(d, w, 42 * scale, "Install FireVoice", urbanist(26 * scale, 700), INK)
    centred_text(d, w, 80 * scale, "Drag FireVoice onto the Applications folder", urbanist(14 * scale, 500), INK_2)
    # an arrow from the app to Applications
    y = 190 * scale
    x0, x1 = 262 * scale, 398 * scale
    d.line((x0, y, x1 - 10 * scale, y), fill=FIRE, width=4 * scale)
    d.polygon([(x1, y), (x1 - 16 * scale, y - 11 * scale), (x1 - 16 * scale, y + 11 * scale)], fill=FIRE)
    d.rectangle((0, h - 4 * scale, w, h), fill=FIRE)
    return img.convert("RGB")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    sidebar().save(OUT / "nsis-sidebar.bmp")
    header().save(OUT / "nsis-header.bmp")
    wix_dialog().save(OUT / "wix-dialog.bmp")
    wix_banner().save(OUT / "wix-banner.bmp")
    dmg(1).save(OUT / "dmg-background.png")
    for f in sorted(OUT.iterdir()):
        print(f.relative_to(ROOT), Image.open(f).size)


if __name__ == "__main__":
    main()
