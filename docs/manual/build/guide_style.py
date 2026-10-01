"""Shared page builder and styles for the picture guides (one step per page, A4 portrait)."""
from __future__ import annotations

import pathlib

MANUAL = pathlib.Path(__file__).resolve().parent.parent


def img(name: str) -> str:
    return (MANUAL / 'guide-images' / f'{name}.png').as_uri()


class Guide:
    def __init__(self) -> None:
        self.pages: list[str] = []
        self.n = 0

    def page(self, inner: str) -> None:
        self.pages.append(f'<section class="page">{inner}</section>')

    def step(self, part: str, title: str, text: str, image: str | None = None, tip: str | None = None, extra: str = '') -> None:
        self.n += 1
        t = f'<div class="tip">{tip}</div>' if tip else ''
        pic = f'<img src="{img(image)}">' if image else ''
        self.page(
            f'<div class="part">{part}</div><div class="stepline"><span class="num">{self.n}</span><h2>{title}</h2></div>'
            f'<p class="do">{text}</p>{pic}{extra}{t}'
        )

    def write(self, out: str) -> None:
        pathlib.Path(out).write_text(
            f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}</style></head><body>{"".join(self.pages)}</body></html>'
        )


SMARTSCREEN = """
<div class="smartscreen"><div class="ss-title">Windows protected your PC</div>
<div class="ss-text">Microsoft Defender SmartScreen prevented an unrecognised app from starting…</div>
<div class="ss-link"><span class="hl">More info</span> <span class="arrow">◀ 1. click</span></div>
<div class="ss-buttons"><span class="arrow">2. “Run anyway” appears: click it ▶</span> <span class="ss-btn hl">Run anyway</span> <span class="ss-btn">Don’t run</span></div></div>
<p class="small center">Drawing: the real window may look a little different.</p>"""

CSS = '''
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1b1b1b; margin: 0; }
.page { break-after: page; min-height: 270mm; position: relative; }
.page:last-child { break-after: auto; }
.part { color: #fff; background: #c8201f; display: inline-block; padding: 4px 12px; border-radius: 6px; font-weight: 700; font-size: 13pt; letter-spacing: .5px; }
.stepline { display: flex; align-items: center; gap: 14px; margin: 14px 0 6px; }
.num { background: #e11d48; color: #fff; font-weight: 800; font-size: 30pt; width: 62px; height: 62px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex: none; }
h2 { font-size: 22pt; margin: 0; line-height: 1.15; }
h2.h { margin: 14px 0 12px; }
p.do { font-size: 16pt; line-height: 1.4; margin: 8px 0 14px; }
img { width: 100%; border: 2px solid #ddd; border-radius: 8px; display: block; }
.tip { margin-top: 14px; background: #fff4d6; border-left: 6px solid #f0a500; padding: 10px 14px; font-size: 14pt; border-radius: 6px; }
.box { background: #fbf0ec; border-left: 6px solid #c8201f; padding: 12px 16px; font-size: 14pt; line-height: 1.45; border-radius: 6px; margin: 14px 0; }
.box ul { margin: 6px 0 0; padding-left: 22px; }
.cover { padding-top: 30mm; }
.brand { font-size: 40pt; font-weight: 900; color: #c8201f; }
.cover h1 { font-size: 34pt; margin: 6px 0 16px; }
.cover h1 span { color: #c8201f; }
.lead { font-size: 17pt; line-height: 1.4; }
.big { font-size: 20pt; margin: 18px 0; }
.small { font-size: 11pt; color: #555; }
.center { text-align: center; }
.diagram { text-align: center; margin: 10px 0 18px; }
.node { display: inline-block; border: 3px solid #c8201f; border-radius: 12px; padding: 10px 14px; font-weight: 700; font-size: 14pt; background: #fff; }
.node small { font-weight: 400; font-size: 10.5pt; color: #444; }
.node.cloud { background: #fdecec; } .node.router { background: #f3f3f3; border-color: #666; }
.node.print { background: #fff8e6; border-color: #f0a500; } .node.inner { border-color: #666; margin-top: 4px; font-size: 12pt; }
.down { font-size: 20pt; color: #c8201f; line-height: 1.2; }
.row4 { display: flex; gap: 10px; justify-content: center; align-items: flex-start; }
.row4 > .node { flex: 1; }
.flow { display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
.flow span { border: 3px solid #1f252c; border-radius: 10px; padding: 8px 12px; font-weight: 800; font-size: 14pt; }
.flow span.a { background: #e32129; border-color: #e32129; color: #fff; }
.flow b { color: #c8201f; font-size: 16pt; }
.smartscreen { background: #0a5fa8; color: #fff; border-radius: 6px; padding: 26px 28px; margin: 10px 0; }
.ss-title { font-size: 22pt; font-weight: 300; margin-bottom: 12px; }
.ss-text { font-size: 12pt; opacity: .9; margin-bottom: 14px; }
.ss-link { font-size: 14pt; margin-bottom: 26px; }
.ss-link .hl { text-decoration: underline; }
.hl { outline: 4px solid #ffdd00; outline-offset: 4px; border-radius: 4px; font-weight: 700; }
.ss-buttons { text-align: right; }
.ss-btn { display: inline-block; border: 2px solid #fff; padding: 6px 16px; margin-left: 12px; font-size: 13pt; }
.arrow { color: #ffdd00; font-weight: 800; font-size: 14pt; }
.cols { display: flex; gap: 14px; }
.cols > div { flex: 1; border-radius: 10px; padding: 8px 16px; font-size: 14pt; line-height: 1.45; }
.yes { background: #e8f6ec; border: 3px solid #1f9d55; } .no { background: #fdecec; border: 3px solid #c8201f; }
.yes h3 { color: #1f9d55; } .no h3 { color: #c8201f; }
.cols h3 { font-size: 20pt; margin: 6px 0; } .cols ul { padding-left: 20px; margin: 0; } .cols li { margin: 6px 0; }
table { width: 100%; border-collapse: collapse; font-size: 13pt; }
th, td { border: 1px solid #ccc; padding: 8px 10px; text-align: left; vertical-align: top; }
th { background: #fbf0ec; }
'''
