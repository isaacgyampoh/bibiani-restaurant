import type { Locator, Page } from '@playwright/test';

/** Red boxes, numbered labels and arrows drawn over real screens for the picture guides. */
type Side = 'left' | 'right' | 'top' | 'bottom';
export interface Mark {
  target: Locator;
  label: string;
  side?: Side;
}

/** Draws the marks over the page, takes the picture, removes the marks. */
export async function annotate(page: Page, path: string, marks: Mark[]) {
  await marks[0]!.target.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await page.waitForTimeout(300);
  const boxes = [];
  for (const m of marks) boxes.push(await m.target.boundingBox());
  await page.evaluate(
    ({ boxes, marks }) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const ns = 'http://www.w3.org/2000/svg';
      const layer = document.createElement('div');
      layer.id = 'guide-marks';
      layer.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Arial,sans-serif';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('width', String(vw));
      svg.setAttribute('height', String(vh));
      svg.style.cssText = 'position:absolute;inset:0';
      svg.innerHTML =
        '<defs><marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#e11d48"/></marker></defs>';
      layer.append(svg);
      document.body.append(layer); // on the page first, so the labels can be measured
      marks.forEach((m, i) => {
        const b = boxes[i];
        if (!b) return;
        const pad = 6;
        const r = { x: b.x - pad, y: b.y - pad, w: b.width + pad * 2, h: b.height + pad * 2 };
        const box = document.createElement('div');
        box.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;border:4px solid #e11d48;border-radius:10px;box-sizing:border-box`;
        layer.append(box);
        const bubble = document.createElement('div');
        bubble.style.cssText =
          'position:absolute;background:#e11d48;color:#fff;font-weight:700;font-size:20px;line-height:1.25;padding:8px 14px;border-radius:12px;max-width:330px;width:max-content;box-sizing:border-box;box-shadow:0 4px 14px rgba(0,0,0,.3)';
        bubble.innerHTML = `<span style="display:inline-block;background:#fff;color:#e11d48;border-radius:50%;width:28px;height:28px;text-align:center;line-height:28px;margin-right:8px">${i + 1}</span> ${m.label}`;
        layer.append(bubble);
        const bw = bubble.offsetWidth;
        const bh = bubble.offsetHeight;
        const gap = 70;
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        let side = m.side ?? 'left';
        let x = 0;
        let y = 0;
        const place = () => {
          if (side === 'left') [x, y] = [r.x - gap - bw, cy - bh / 2];
          if (side === 'right') [x, y] = [r.x + r.w + gap, cy - bh / 2];
          if (side === 'top') [x, y] = [cx - bw / 2, r.y - gap - bh];
          if (side === 'bottom') [x, y] = [cx - bw / 2, r.y + r.h + gap];
        };
        place();
        if (side === 'left' && x < 8) {
          side = 'bottom';
          place();
        }
        if (side === 'right' && x + bw > vw - 8) {
          side = 'left';
          place();
        }
        x = Math.max(8, Math.min(vw - bw - 8, x));
        y = Math.max(8, Math.min(vh - bh - 8, y));
        bubble.style.left = `${x}px`;
        bubble.style.top = `${y}px`;
        const from = {
          left: [x + bw, y + bh / 2],
          right: [x, y + bh / 2],
          top: [x + bw / 2, y + bh],
          bottom: [x + bw / 2, y],
        }[side]!;
        const to = { left: [r.x, cy], right: [r.x + r.w, cy], top: [cx, r.y], bottom: [cx, r.y + r.h] }[
          side
        ]!;
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', String(from[0]));
        line.setAttribute('y1', String(from[1]));
        line.setAttribute('x2', String(to[0]));
        line.setAttribute('y2', String(to[1]));
        line.setAttribute('stroke', '#e11d48');
        line.setAttribute('stroke-width', '5');
        line.setAttribute('marker-end', 'url(#ah)');
        svg.append(line);
      });
    },
    { boxes, marks: marks.map((m) => ({ label: m.label, side: m.side })) },
  );
  await page.screenshot({ path });
  await page.evaluate(() => document.getElementById('guide-marks')?.remove());
}
