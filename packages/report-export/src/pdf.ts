import type { ReportColumn, ReportTable, ReportValue, ReportView } from '@rp/contracts';
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib';
import { display, header } from './format';

/**
 * A structured, printable PDF (text and vector lines, not a picture of the screen): the MY FOOD /
 * restaurant header on every page, the report title, period and generation time, the summary
 * figures, then each table with its header row repeated on every page, wrapped cells (nothing is
 * clipped), a totals row, notes, signature lines where the report has them, and "Page x of y".
 *
 * Standard PDF fonts only cover Western European characters, so amounts use the currency code
 * (GHS) and other characters are replaced by their closest plain letter.
 */
const A4: [number, number] = [595.28, 841.89];
const MARGIN = 36;
const BRAND = rgb(0.89, 0.13, 0.16);
const INK = rgb(0.07, 0.08, 0.09);
const MUTED = rgb(0.4, 0.43, 0.48);
const LINE = rgb(0.82, 0.84, 0.87);
const ZEBRA = rgb(0.965, 0.97, 0.975);
const HEAD_BG = rgb(0.07, 0.08, 0.09);

const NUMERIC = new Set(['money', 'int', 'qty', 'percent']);

export async function renderPdf(view: ReportView): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${view.title} — ${view.period.label}`);
  doc.setAuthor('MY FOOD');
  doc.setSubject(view.restaurantName);
  doc.setCreator('MY FOOD');
  doc.setProducer('MY FOOD');
  doc.setCreationDate(new Date(view.generatedAt));
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const landscape = view.tables.some((t) => t.columns.length > 7);
  const size: [number, number] = landscape ? [A4[1], A4[0]] : A4;
  const w = new Writer(doc, view, regular, bold, size);

  w.newPage();
  // Filters
  if (view.filters.length) {
    w.ensure(14);
    w.text(
      `Filters: ${view.filters.map((f) => `${f.label}: ${f.value}`).join('   ·   ')}`,
      8.5,
      regular,
      MUTED,
    );
    w.y -= 14;
  }
  // Summary: each group as a titled block of label / value pairs, two columns.
  for (const g of view.summary) {
    const rows = Math.ceil(g.metrics.length / 2);
    w.ensure(22 + Math.min(rows, 3) * 15);
    w.sectionTitle(g.title);
    const colW = (w.width - 16) / 2;
    g.metrics.forEach((m, i) => {
      const col = i % 2;
      if (col === 0) w.ensure(15);
      const x = MARGIN + col * (colW + 16);
      const label = m.format === 'money' ? `${m.label}` : m.label;
      const value =
        m.format === 'money' && m.value !== null
          ? `${Number(m.value) < 0 ? '-' : ''}${view.currency} ${display(Math.abs(Number(m.value)), 'money', view)}`
          : display(m.value, m.format, view);
      const font = m.emphasis ? bold : regular;
      w.textAt(x, w.y, label, 9, font, m.emphasis ? INK : w.muted);
      const vw = font.widthOfTextAtSize(w.safe(value || '—'), 9.5);
      w.textAt(x + colW - vw, w.y, value || '—', 9.5, font, INK);
      w.page.drawLine({
        start: { x, y: w.y - 4 },
        end: { x: x + colW, y: w.y - 4 },
        thickness: 0.4,
        color: LINE,
      });
      if (col === 1 || i === g.metrics.length - 1) w.y -= 15;
    });
    w.y -= 8;
  }
  for (const t of view.tables) w.table(t);
  if (view.notes.length) {
    w.ensure(30);
    w.sectionTitle('Notes');
    for (const n of view.notes) {
      for (const line of w.wrap(n, regular, 8.5, w.width)) {
        w.ensure(11);
        w.text(line, 8.5, regular, MUTED);
        w.y -= 11;
      }
      w.y -= 3;
    }
  }
  if (view.signOff.length) {
    w.ensure(30 + view.signOff.length * 40);
    w.y -= 16;
    for (const s of view.signOff) {
      w.y -= 26;
      w.page.drawLine({
        start: { x: MARGIN, y: w.y },
        end: { x: MARGIN + 240, y: w.y },
        thickness: 0.8,
        color: INK,
      });
      w.textAt(MARGIN, w.y - 11, s, 8.5, regular, MUTED);
      w.textAt(MARGIN + 270, w.y - 11, 'Date: ____________________', 8.5, regular, MUTED);
      w.y -= 14;
    }
  }
  w.footers();
  // Plain object structure (no object streams): opens in every PDF reader, including older ones.
  return doc.save({ useObjectStreams: false });
}

class Writer {
  page!: PDFPage;
  y = 0;
  readonly width: number;
  readonly muted = MUTED;
  private readonly pages: PDFPage[] = [];
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly doc: PDFDocument,
    private readonly view: ReportView,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
    private readonly size: [number, number],
  ) {
    this.width = size[0] - MARGIN * 2;
  }

  /** Text the standard fonts can draw: unsupported characters become their plain letter or "?". */
  safe(s: string): string {
    let out = '';
    for (const ch of s.replace(/₵/g, 'GHS ').replace(/[\r\n\t]+/g, ' ')) {
      let ok = this.cache.get(ch);
      if (ok === undefined) {
        try {
          this.regular.encodeText(ch);
          ok = ch;
        } catch {
          const plain = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
          ok =
            { ɛ: 'e', Ɛ: 'E', ɔ: 'o', Ɔ: 'O', ŋ: 'n', Ŋ: 'N' }[ch] ??
            (plain && plain !== ch ? this.safe(plain) : '?');
        }
        this.cache.set(ch, ok);
      }
      out += ok;
    }
    return out;
  }

  newPage(): void {
    this.page = this.doc.addPage(this.size);
    this.pages.push(this.page);
    const top = this.size[1] - MARGIN;
    const v = this.view;
    this.textAt(MARGIN, top - 12, 'MY FOOD', 14, this.bold, BRAND);
    this.textAt(MARGIN, top - 26, v.restaurantName.toUpperCase(), 9, this.bold, INK);
    const title = v.title.toUpperCase();
    const tw = this.bold.widthOfTextAtSize(this.safe(title), 13);
    this.textAt(MARGIN + this.width - tw, top - 12, title, 13, this.bold, INK);
    const period = v.period.label;
    const pw = this.regular.widthOfTextAtSize(this.safe(period), 9);
    this.textAt(MARGIN + this.width - pw, top - 26, period, 9, this.regular, INK);
    const gen = `Generated ${v.generatedAtLocal}${v.generatedBy ? ` by ${v.generatedBy}` : ''} · ${v.branchName} · amounts in ${v.currency}`;
    const gw = this.regular.widthOfTextAtSize(this.safe(gen), 7.5);
    this.textAt(MARGIN + this.width - gw, top - 38, gen, 7.5, this.regular, MUTED);
    this.page.drawLine({
      start: { x: MARGIN, y: top - 46 },
      end: { x: MARGIN + this.width, y: top - 46 },
      thickness: 1.2,
      color: BRAND,
    });
    this.y = top - 64;
  }

  /** Starts a new page when fewer than `needed` points are left above the footer. */
  ensure(needed: number): boolean {
    if (this.y - needed < MARGIN + 24) {
      this.newPage();
      return true;
    }
    return false;
  }

  textAt(x: number, y: number, s: string, size: number, font: PDFFont, color = INK): void {
    this.page.drawText(this.safe(s), { x, y, size, font, color });
  }

  text(s: string, size: number, font: PDFFont, color = INK): void {
    this.textAt(MARGIN, this.y, s, size, font, color);
  }

  sectionTitle(title: string): void {
    this.textAt(MARGIN, this.y, title.toUpperCase(), 9.5, this.bold, BRAND);
    this.y -= 15;
  }

  wrap(s: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const words = this.safe(s).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= maxWidth) line = next;
      else {
        if (line) lines.push(line);
        // A single word longer than the column is broken by characters.
        let rest = word;
        while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
          let cut = rest.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut--;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
    }
    if (line || lines.length === 0) lines.push(line);
    return lines;
  }

  /** Column widths: numbers get what they need; text shares the rest, wrapping when needed. */
  private widths(t: ReportTable, size: number): number[] {
    const PAD = 8;
    const need = t.columns.map((c) => {
      const cells = [
        header(c.label, c.format, this.view.currency),
        ...t.rows.slice(0, 400).map((r) => this.cell(r[c.key] ?? null, c)),
      ];
      if (t.totals) cells.push(this.cell(t.totals[c.key] ?? null, c));
      const font = (i: number) => (i === 0 ? this.bold : this.regular);
      const widest = Math.max(
        ...cells.map((s, i) =>
          i === 0 && !NUMERIC.has(c.format)
            ? // Headers may wrap onto two lines.
              Math.max(
                ...this.safe(s)
                  .split(' ')
                  .map((wd) => font(i).widthOfTextAtSize(wd, size)),
              )
            : font(i).widthOfTextAtSize(this.safe(s), size),
        ),
      );
      return widest + PAD;
    });
    const total = need.reduce((a, b) => a + b, 0);
    if (total <= this.width) {
      // Spare room goes to text columns.
      const text = t.columns.map((c, i) => (NUMERIC.has(c.format) ? 0 : need[i]!));
      const textTotal = text.reduce((a, b) => a + b, 0);
      const spare = this.width - total;
      return need.map((n, i) => n + (textTotal ? (spare * text[i]!) / textTotal : spare / need.length));
    }
    const numericTotal = t.columns.reduce((s, c, i) => s + (NUMERIC.has(c.format) ? need[i]! : 0), 0);
    const textCols = t.columns.filter((c) => !NUMERIC.has(c.format)).length;
    const room = this.width - numericTotal;
    if (room >= textCols * 40) {
      const textNeed = total - numericTotal;
      return t.columns.map((c, i) =>
        NUMERIC.has(c.format) ? need[i]! : Math.max(40, (need[i]! / textNeed) * room),
      );
    }
    return need.map((n) => (n / total) * this.width);
  }

  private cell(v: ReportValue, c: ReportColumn): string {
    return display(v, c.format, this.view);
  }

  table(t: ReportTable): void {
    let size = 8;
    if (t.columns.length > 10) size = 7;
    if (t.columns.length > 13) size = 6.5;
    const widths = this.widths(t, size);
    const lineH = size + 2.5;
    const headLines = t.columns.map((c, i) =>
      this.wrap(header(c.label, c.format, this.view.currency), this.bold, size, widths[i]! - 6),
    );
    const headH = Math.max(...headLines.map((l) => l.length)) * lineH + 6;

    const drawHeader = () => {
      this.page.drawRectangle({
        x: MARGIN,
        y: this.y - headH + lineH - 1,
        width: this.width,
        height: headH,
        color: HEAD_BG,
      });
      let x = MARGIN;
      t.columns.forEach((c, i) => {
        headLines[i]!.forEach((line, li) => {
          const lw = this.bold.widthOfTextAtSize(line, size);
          const tx = NUMERIC.has(c.format) ? x + widths[i]! - 3 - lw : x + 3;
          this.page.drawText(line, {
            x: tx,
            y: this.y - li * lineH,
            size,
            font: this.bold,
            color: rgb(1, 1, 1),
          });
        });
        x += widths[i]!;
      });
      this.y -= headH;
    };

    this.ensure(40 + headH);
    this.sectionTitle(t.title);
    drawHeader();
    if (t.rows.length === 0) {
      this.textAt(MARGIN + 3, this.y - 2, t.empty, size + 0.5, this.regular, MUTED);
      this.y -= lineH + 14;
      return;
    }
    const drawRow = (r: Record<string, ReportValue>, index: number, totals: boolean) => {
      const font = totals ? this.bold : this.regular;
      const cells = t.columns.map((c, i) => {
        const v = r[c.key] ?? null;
        const s = this.cell(v, c);
        return NUMERIC.has(c.format) ? [this.safe(s)] : this.wrap(s, font, size, widths[i]! - 6).slice(0, 6);
      });
      const h = Math.max(...cells.map((l) => l.length)) * lineH + 3;
      if (this.ensure(h + 2)) {
        this.sectionTitle(`${t.title} (continued)`);
        drawHeader();
      }
      if (totals)
        this.page.drawLine({
          start: { x: MARGIN, y: this.y + lineH - 1 },
          end: { x: MARGIN + this.width, y: this.y + lineH - 1 },
          thickness: 0.9,
          color: INK,
        });
      else if (index % 2 === 1)
        this.page.drawRectangle({
          x: MARGIN,
          y: this.y - h + lineH,
          width: this.width,
          height: h,
          color: ZEBRA,
        });
      let x = MARGIN;
      t.columns.forEach((c, i) => {
        cells[i]!.forEach((line, li) => {
          const lw = font.widthOfTextAtSize(line, size);
          const tx = NUMERIC.has(c.format) ? x + widths[i]! - 3 - lw : x + 3;
          const neg = NUMERIC.has(c.format) && line.startsWith('-');
          this.page.drawText(line, {
            x: tx,
            y: this.y - li * lineH,
            size,
            font,
            color: neg ? rgb(0.77, 0.15, 0.11) : INK,
          });
        });
        x += widths[i]!;
      });
      this.y -= h;
    };
    t.rows.forEach((r, i) => {
      drawRow(r, i, false);
    });
    if (t.totals) drawRow(t.totals, 0, true);
    this.y -= 14;
  }

  footers(): void {
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      const label = `Page ${i + 1} of ${total}`;
      const size = 7.5;
      p.drawLine({
        start: { x: MARGIN, y: MARGIN + 12 },
        end: { x: MARGIN + this.width, y: MARGIN + 12 },
        thickness: 0.4,
        color: LINE,
      });
      p.drawText(
        this.safe(`MY FOOD · ${this.view.restaurantName} · ${this.view.title} · ${this.view.period.label}`),
        {
          x: MARGIN,
          y: MARGIN,
          size,
          font: this.regular,
          color: MUTED,
        },
      );
      const lw = this.regular.widthOfTextAtSize(label, size);
      p.drawText(label, { x: MARGIN + this.width - lw, y: MARGIN, size, font: this.regular, color: MUTED });
    });
  }
}
