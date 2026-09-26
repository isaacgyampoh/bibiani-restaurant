"""Flat, crisp version of the MY FOOD logo for the app UI.

The supplied logo is a raster with a soft drop-shadow ring and pinkish anti-aliasing, which reads as a
blurry gradient when scaled down. This keeps everything inside the white gap around the red ring,
removes the shadow ring, and snaps every pixel to brand red, ink or white (keeping smooth edges).
Run: python3 scripts/brand/make-flat-logo.py
"""
from PIL import Image, ImageDraw

SRC = 'apps/web/public/logo-original-512.png'
BRAND = (227, 33, 41)  # #E32129
INK = (28, 28, 30)
KEEP_R = 226  # inside the white gap (red ring ends ~211, shadow ring ~236)

im = Image.open(SRC).convert('RGB')
w, h = im.size
cx, cy = w / 2, h / 2
out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
px = im.load()
po = out.load()
clamp = lambda v: max(0.0, min(1.0, v))
lerp = lambda a, b, t: tuple(round(x + (y - x) * t) for x, y in zip(a, b))
for y in range(h):
    for x in range(w):
        if (x - cx) ** 2 + (y - cy) ** 2 > KEEP_R**2:
            continue
        r, g, b = px[x, y]
        if r - g > 45:  # red ink (including its pink anti-aliased edge)
            t = clamp((255 - g) / (255 - 40))
            c = lerp((255, 255, 255), BRAND, t)
        else:  # dark ink or paper
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            t = clamp((235 - lum) / (235 - 40))
            c = lerp((255, 255, 255), INK, t)
        po[x, y] = (*c, 255)

# Smooth circular edge for the white disc.
mask = Image.new('L', (w * 4, h * 4), 0)
ImageDraw.Draw(mask).ellipse((4 * (cx - KEEP_R), 4 * (cy - KEEP_R), 4 * (cx + KEEP_R), 4 * (cy + KEEP_R)), fill=255)
mask = mask.resize((w, h), Image.LANCZOS)
out.putalpha(Image.composite(out.getchannel('A'), mask, mask).point(lambda a: a))
alpha = Image.eval(mask, lambda a: a)
out.putalpha(alpha)
# Crop to the disc so the mark fills its box.
box = (round(cx - KEEP_R), round(cy - KEEP_R), round(cx + KEEP_R), round(cy + KEEP_R))
out = out.crop(box)
for size in (512, 192, 64, 32):
    out.resize((size, size), Image.LANCZOS).save(f'apps/web/public/logo-{size}.png', optimize=True)
print('ok', out.size)
