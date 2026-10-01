"""Markdown manual -> print HTML (A4). Usage: python md2html.py <source.md> <out.html> <compact 0|1>"""
import pathlib
import sys

import markdown

src, out, compact = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
text = pathlib.Path(src).read_text()
body = markdown.markdown(text, extensions=['tables', 'fenced_code', 'sane_lists'])
base = pathlib.Path(src).parent.resolve().as_uri() + '/'
size = '9pt' if compact else '10.5pt'
css = f"""
@page {{ size: A4; margin: {'10mm' if compact else '16mm 15mm'}; }}
body {{ font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: {size}; line-height: 1.45; color: #1b1b1b; }}
h1 {{ font-size: {'17pt' if compact else '26pt'}; color: #b4481f; margin: 0 0 4px; }}
h2 {{ font-size: {'12pt' if compact else '16pt'}; color: #b4481f; border-bottom: 2px solid #b4481f; padding-bottom: 3px; margin-top: {'10px' if compact else '26px'}; {'' if compact else 'break-before: page;'} }}
h1 + h2, h1 + p + h2 {{ break-before: auto; }}
h3 {{ font-size: {'10.5pt' if compact else '12.5pt'}; margin: 14px 0 4px; }}
table {{ border-collapse: collapse; width: 100%; margin: 6px 0 10px; break-inside: auto; }}
tr {{ break-inside: avoid; }}
th, td {{ border: 1px solid #c9c9c9; padding: {'3px 5px' if compact else '4px 6px'}; vertical-align: top; text-align: left; }}
th {{ background: #f4e7df; }}
blockquote {{ border-left: 4px solid #b4481f; background: #fbf3ee; margin: 8px 0; padding: 6px 12px; break-inside: avoid; }}
code {{ font-family: Menlo, Consolas, monospace; font-size: 0.92em; background: #f2f2f2; padding: 0 3px; }}
pre {{ background: #f6f6f6; padding: 8px; font-size: 8pt; line-height: 1.25; break-inside: avoid; white-space: pre; }}
img {{ max-width: 100%; max-height: 118mm; border: 1px solid #ccc; display: block; margin: 6px auto; break-inside: avoid; }}
p:has(img + img) img {{ display: inline-block; max-width: 48%; margin: 4px 1%; }}
li {{ margin: 2px 0; }}
a {{ color: #1b1b1b; }}
"""
html = f'<!doctype html><html><head><meta charset="utf-8"><base href="{base}"><style>{css}</style></head><body>{body}</body></html>'
pathlib.Path(out).write_text(html)
