"""Web-ready texture set from the Codex-generated images (game/public/tex/gen -> game/public/tex/w2).
Tiling albedos -> 1024 JPG + a tangent-space normal map from luminance (detail height); cards keep PNG alpha
(premultiplied-safe: colour bled into transparent texels so mipmaps don't fringe); sky -> JPG."""
import numpy as np, os
from PIL import Image, ImageFilter
SRC = "/home/shikhar/Projects/samurai/game/public/tex/gen"
DST = "/home/shikhar/Projects/samurai/game/public/tex/w2"
os.makedirs(DST, exist_ok=True)
TILE = ["bark", "cliff_rock", "dirt", "flagstone", "masonry", "meadow", "moss", "snow_rock", "stone_weathered"]
STRENGTH = {"bark": 3.0, "cliff_rock": 3.5, "dirt": 2.0, "flagstone": 3.5, "masonry": 3.5, "meadow": 1.5, "moss": 2.0,
            "snow_rock": 2.5, "stone_weathered": 2.5}
for n in TILE:
    im = Image.open(f"{SRC}/{n}_albedo.png").convert("RGB").resize((1024, 1024), Image.LANCZOS)
    im.save(f"{DST}/{n}.jpg", quality=90)
    a = np.asarray(im).astype(np.float32) / 255
    h = (a @ [0.3, 0.59, 0.11])
    hb = np.asarray(Image.fromarray((h * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32) / 255
    big = np.asarray(Image.fromarray((h * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(12))).astype(np.float32) / 255
    hh = hb - big * 0.6                                     # remove low-frequency lighting, keep relief
    s = STRENGTH[n]
    dx = (np.roll(hh, -1, 1) - np.roll(hh, 1, 1)) * s       # wraps -> stays tileable
    dy = (np.roll(hh, -1, 0) - np.roll(hh, 1, 0)) * s
    nz = np.ones_like(dx)
    nrm = np.stack([-dx, dy, nz], -1)
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    Image.fromarray(((nrm * 0.5 + 0.5) * 255).astype(np.uint8)).save(f"{DST}/{n}_n.jpg", quality=92)
for n in ["grass_card", "red_flowers_card", "maple_red_card", "maple_orange_card", "mountains_far_strip"]:
    im = Image.open(f"{SRC}/{n}.png").convert("RGBA")
    w, h = im.size
    sc = 1024 / max(w, h) if n != "mountains_far_strip" else 2048 / max(w, h)
    im = im.resize((int(w * sc) // 4 * 4, int(h * sc) // 4 * 4), Image.LANCZOS)
    arr = np.asarray(im).astype(np.float32)
    # bleed colour into transparent texels (avoid dark halos when mip-mapped / alpha-tested)
    rgb, al = arr[..., :3], arr[..., 3:] / 255
    acc = rgb * al
    wsum = al.copy()
    for r in (2, 4, 8, 16, 32):
        blur = lambda x: np.asarray(Image.fromarray(np.clip(x, 0, 255).astype(np.uint8) if x.shape[-1] != 1 else np.clip(x[..., 0] * 255, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r))).astype(np.float32)
        a2 = blur(wsum) / 255
        c2 = np.stack([blur(acc[..., k:k+1] * 0 + acc[..., k:k+1])[..., None] if False else np.asarray(Image.fromarray(np.clip(acc[..., k], 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r))).astype(np.float32) for k in range(3)], -1)
        fill = c2 / np.maximum(a2[..., None] if a2.ndim == 2 else a2, 1e-3)
        m = (wsum[..., 0] < 0.5)
        rgb = np.where(m[..., None], fill, rgb)
    out = np.concatenate([np.clip(rgb, 0, 255), arr[..., 3:]], -1).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(f"{DST}/{n}.png", optimize=True)
Image.open(f"{SRC}/sky_panorama.png").convert("RGB").resize((2048, 1024), Image.LANCZOS).save(f"{DST}/sky.jpg", quality=92)
for f in sorted(os.listdir(DST)):
    print(f, os.path.getsize(f"{DST}/{f}") // 1024, "KB")
