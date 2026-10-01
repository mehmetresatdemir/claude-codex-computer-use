#!/usr/bin/env python3
"""Pillow ile gün batımında yelkenli sahnesi çizer (docs/ornek-yelkenli.png)."""
import sys
from PIL import Image, ImageDraw

out = sys.argv[1] if len(sys.argv) > 1 else "yelkenli.png"
W, H = 1400, 900
im = Image.new("RGB", (W, H)); d = ImageDraw.Draw(im)
def lerp(a, b, u): return tuple(int(a[i]*(1-u) + b[i]*u) for i in range(3))
for y in range(560):                                                           # gökyüzü degrade
    t = y / 560
    c = lerp((90, 40, 120), (255, 120, 80), t/0.5) if t < 0.5 else lerp((255, 120, 80), (255, 200, 90), (t-0.5)/0.5)
    d.line([0, y, W, y], fill=c)
d.ellipse([560, 400, 840, 680], fill=(255, 230, 120))                          # güneş
for y in range(560, H):                                                        # deniz
    d.line([0, y, W, y], fill=lerp((30, 80, 140), (10, 30, 70), (y-560)/(H-560)))
for i in range(14):                                                            # yansıma
    y = 575 + i*22; w = 120 + i*14 + (30 if i % 2 else 0)
    d.rectangle([700-w//2, y, 700+w//2, y+7], fill=(255, 210, 120))
for i in range(40):                                                            # dalgalar
    x = (i*97) % W; y = 600 + (i*53) % 280
    d.arc([x, y, x+70, y+24], 0, 180, fill=(170, 210, 240), width=3)
d.polygon([(420, 700), (980, 700), (920, 790), (480, 790)], fill=(90, 45, 20))  # gövde
d.rectangle([420, 690, 980, 705], fill=(140, 70, 30))
d.line([700, 700, 700, 330], fill=(60, 30, 15), width=10)                      # direk
d.polygon([(710, 340), (710, 690), (960, 690)], fill=(250, 250, 245))          # büyük yelken
d.polygon([(690, 380), (690, 690), (470, 690)], fill=(235, 90, 70))            # ön yelken
d.polygon([(700, 330), (700, 370), (780, 350)], fill=(230, 40, 40))            # bayrak
for x, y in [(220, 180), (300, 140), (1100, 220), (1180, 170)]:                # martılar
    d.arc([x, y, x+40, y+30], 200, 340, fill="white", width=4)
    d.arc([x+36, y, x+76, y+30], 200, 340, fill="white", width=4)
im.save(out); print("yazıldı:", out)
