#!/usr/bin/env python3
"""Pillow ile basit bir ev sahnesi çizer (docs/ornek-ev.png). Freeform'a dosya olarak eklemek için."""
import math, sys
from PIL import Image, ImageDraw

out = sys.argv[1] if len(sys.argv) > 1 else "ev.png"
W, H = 1200, 800
im = Image.new("RGB", (W, H), "#87CEEB"); d = ImageDraw.Draw(im)
d.rectangle([0, 560, W, H], fill="#4CAF50")                                   # çimen
d.ellipse([980, 60, 1140, 220], fill="#FFD83D")                                # güneş
for i in range(12):                                                            # ışınlar
    a = i * math.pi / 6; cx, cy = 1060, 140
    d.line([cx + 95*math.cos(a), cy + 95*math.sin(a), cx + 130*math.cos(a), cy + 130*math.sin(a)], fill="#FFD83D", width=8)
for cx, cy in [(220, 150), (560, 110)]:                                        # bulutlar
    for dx, dy, r in [(0, 0, 55), (60, -15, 65), (120, 0, 55), (60, 25, 50)]:
        d.ellipse([cx+dx-r, cy+dy-r, cx+dx+r, cy+dy+r], fill="white")
d.rectangle([380, 330, 780, 600], fill="#F6E27F", outline="#8B6914", width=5)  # gövde
d.polygon([(340, 330), (580, 160), (820, 330)], fill="#D32F2F", outline="#7F1A1A")  # çatı
d.rectangle([640, 190, 690, 300], fill="#8B5A2B")                              # baca
d.rectangle([540, 450, 620, 600], fill="#6D4C41", outline="#3E2723", width=4)  # kapı
d.ellipse([600, 520, 614, 534], fill="#FFD83D")                                # kol
for x in [420, 680]:                                                           # pencereler
    d.rectangle([x, 380, x+80, 460], fill="#B3E5FC", outline="#5D4037", width=4)
    d.line([x+40, 380, x+40, 460], fill="#5D4037", width=4); d.line([x, 420, x+80, 420], fill="#5D4037", width=4)
d.rectangle([150, 460, 180, 600], fill="#8B5A2B")                              # ağaç
for cx, cy, r in [(165, 420, 75), (120, 470, 55), (210, 470, 55)]:
    d.ellipse([cx-r, cy-r, cx+r, cy+r], fill="#2E7D32")
d.rectangle([250, 600, 900, 620], fill="#A1887F")                              # yol
im.save(out); print("yazıldı:", out)
