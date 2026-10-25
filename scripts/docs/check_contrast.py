#!/usr/bin/env python3
"""UI-1 (DEC-076): every text colour of the visual system reaches 4.5:1 (WCAG 2.x AA, normal text) on each surface it sits on, in
light and dark. Exits 1 if any pair falls short. The pairs mirror apps/web/src/app/globals.css."""
import sys

def lum(h):
    h = h.lstrip('#'); r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True); return (la + 0.05) / (lb + 0.05)

LIGHT = {'ground': '#f2f4f7', 'sheet': '#ffffff', 'active': '#e3e8ee'}
DARK = {'ground': '#0c0d0f', 'sheet': '#15171a', 'active': '#23272d'}
TEXT_LIGHT = {'ink': '#172231', 'pencil': '#566170', 'signal': '#1d5fbf', 'red': '#b3261e', 'green': '#276b2b'}
TEXT_DARK = {'ink': '#f2f4f7', 'pencil': '#aab2bd', 'signal': '#6d9eea', 'red': '#f08a80', 'green': '#5bbf73'}
PILLS = [('positive', '#04250e', '#dcfae5'), ('negative', '#831c1e', '#ffedea'), ('notice', '#92400e', '#fffbeb'), ('neutral', '#3a4553', '#e9edf2'),
         ('red ink on its error tint', '#b3261e', '#ffedea'), ('primary label', '#ffffff', '#172231'), ('dark primary label', '#15171a', '#f2f4f7')]
bad = 0
for theme, surfaces, texts in (('light', LIGHT, TEXT_LIGHT), ('dark', DARK, TEXT_DARK)):
    for t, tc in texts.items():
        for s, sc in surfaces.items():
            r = ratio(tc, sc); ok = r >= 4.5; bad += not ok
            print(f'{theme:5} {t:7} on {s:6} {r:5.2f}:1 {"OK" if ok else "FAILS"}')
for name, fg, bg in PILLS:
    r = ratio(fg, bg); ok = r >= 4.5; bad += not ok
    print(f'pill  {name:26} {r:5.2f}:1 {"OK" if ok else "FAILS"}')
print(f'failures: {bad}')
sys.exit(1 if bad else 0)
