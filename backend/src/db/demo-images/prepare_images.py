#!/usr/bin/env python3
"""Turn raw generated images in incoming/ into demo-ready square JPEGs.

Usage (from backend/src/db/demo-images):  python3 prepare_images.py

For each incoming/<slug>.(png|jpg|jpeg|webp): pad to a square on white (never
crops the garment), resize to 720px, save as <slug>.jpg (under 1 MB, the order
photo limit). Files whose names are not a known slug are reported and skipped.
"""
import os, sys
from PIL import Image, ImageOps

SLUGS = ['zip-up-recovery-jacket', 'cuffed-joggers', 'recovery-tee', 'hooded-tank', 'baggy-active-jacket',
         'drifit-joggers', 'studio-leggings', 'pace-running-shorts', 'core-crew-sweatshirt', 'stride-track-jacket',
         'flex-sports-bra', 'aero-windbreaker', 'long-sleeve-training-tee', 'cropped-fleece-hoodie',
         'slim-fit-jeans', 'polo-tshirt']
here = os.path.dirname(os.path.abspath(__file__))
inc = os.path.join(here, 'incoming')
done, skipped = [], []
for f in sorted(os.listdir(inc)):
    stem, ext = os.path.splitext(f)
    if ext.lower() not in ('.png', '.jpg', '.jpeg', '.webp'): continue
    if stem not in SLUGS: skipped.append(f); continue
    im = Image.open(os.path.join(inc, f))
    im = ImageOps.exif_transpose(im).convert('RGB')
    side = max(im.size)
    canvas = Image.new('RGB', (side, side), (255, 255, 255))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    out = canvas.resize((720, 720), Image.LANCZOS)
    path = os.path.join(here, stem + '.jpg')
    for q in (88, 80, 70):
        out.save(path, 'JPEG', quality=q, optimize=True)
        if os.path.getsize(path) < 900 * 1024: break
    done.append((stem, os.path.getsize(path) // 1024))
for s, kb in done: print(f'ok       {s}.jpg  {kb} KB')
for f in skipped: print(f'skipped  {f}  (not a known product name)')
print(f'\n{len(done)} of {len(SLUGS)} ready.', 'Missing: ' + ', '.join(s for s in SLUGS if s not in dict(done)) if len(done) < len(SLUGS) else '')
