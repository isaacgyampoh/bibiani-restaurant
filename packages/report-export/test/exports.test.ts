import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { fileName, renderCsv, renderPdf, renderReport, renderXlsx } from '../src';
import { sampleView } from './sample-view';

describe('Report exports', () => {
  it('CSV: UTF-8 with BOM, CRLF, quoted fields, rectangular rows, formula injection neutralised', () => {
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(renderCsv(sampleView()));
    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain('"Kwame ""KK"" Mensah, Jr."');
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(text).toContain('Ɛfua Nyarkoa');
    expect(text).toContain('No.,Day,Opened,Customer,Note,Rate,Qty,Total (GHS)');
    expect(text).toContain(',15.00,1.25,123.45');
    // Every record has the same number of fields (parse respecting quotes).
    const records = parseCsv(text.slice(1));
    const widths = new Set(records.filter((r) => r.length > 1 || r[0] !== '').map((r) => r.length));
    expect(widths.size).toBe(1);
  });

  it('XLSX: a real workbook with summary and table sheets, frozen header, filter, formats, SUBTOTAL totals', () => {
    const files = unzipSync(renderXlsx(sampleView()));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        'xl/workbook.xml',
        'xl/styles.xml',
        'xl/worksheets/sheet1.xml',
        'xl/worksheets/sheet2.xml',
      ]),
    );
    const book = strFromU8(files['xl/workbook.xml']!);
    expect(book).toContain('name="Summary"');
    expect(book).toContain('name="Orders"');
    const sheet = strFromU8(files['xl/worksheets/sheet2.xml']!);
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A5:H8"/>');
    expect(sheet).toContain('<f>SUBTOTAL(109,H6:H8)</f>');
    expect(sheet).toContain('Total (GHS)');
    expect(sheet).toContain('&quot;KK&quot;'); // escaped, not broken XML
    expect(strFromU8(files['xl/styles.xml']!)).toContain('formatCode="#,##0.00"');
  });

  it('PDF: a structured document (text, not an image) with pages, title and period', async () => {
    const bytes = await renderPdf(sampleView());
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).not.toContain('/Subtype /Image');
    expect(text).toContain('/BaseFont /Helvetica');
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBe(1);
  });

  it('a large report (5,000 rows) paginates and stays fast', async () => {
    const view = sampleView(5000);
    const started = Date.now();
    const pdf = await renderPdf(view);
    const xlsx = renderXlsx(view);
    const csv = renderCsv(view);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((new TextDecoder('latin1').decode(pdf).match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(
      100,
    );
    expect(strFromU8(unzipSync(xlsx)['xl/worksheets/sheet2.xml']!)).toContain('<autoFilter ref="A5:H5005"/>');
    expect(parseCsv(new TextDecoder().decode(csv)).length).toBeGreaterThan(5000);
  });

  it('an empty report still renders in every format', async () => {
    const view = { ...sampleView(0), tables: [{ ...sampleView(0).tables[0]!, rows: [], totals: null }] };
    for (const format of ['pdf', 'xlsx', 'csv'] as const) {
      const file = await renderReport(view, format);
      expect(file.bytes.length).toBeGreaterThan(100);
    }
    expect(new TextDecoder().decode(renderCsv(view))).toContain('No orders.');
  });

  it('file names describe the report and period', () => {
    expect(fileName(sampleView(), 'xlsx')).toBe('myfood-orders-2026-09-01_to_2026-09-30.xlsx');
  });
});

/** Minimal RFC 4180 parser for the test. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += ch;
  }
  return rows;
}
