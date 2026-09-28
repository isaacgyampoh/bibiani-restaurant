import type { ReportFormat, ReportValue, ReportView } from '@rp/contracts';
import { display, header, money, quantity } from './format';

/**
 * CSV (RFC 4180): UTF-8 with a byte-order mark (so Excel reads accents correctly), CRLF line
 * endings, every field that needs it quoted, and a rectangular layout (every row has the same
 * number of fields). Numbers are written plainly (1234.50) so spreadsheets read them as numbers.
 * Text that a spreadsheet would run as a formula (= + - @) is prefixed with an apostrophe.
 */
export function renderCsv(view: ReportView): Uint8Array {
  const rows: string[][] = [];
  const meta = (label: string, value: string) => rows.push([label, value]);
  meta('Report', view.title);
  meta('Restaurant', `${view.restaurantName} (${view.branchName})`);
  meta('Period', view.period.label);
  meta('Generated', `${view.generatedAtLocal}${view.generatedBy ? ` by ${view.generatedBy}` : ''}`);
  meta('Currency', view.currency);
  for (const f of view.filters) meta(`Filter: ${f.label}`, f.value);
  rows.push([]);
  for (const g of view.summary) {
    rows.push([g.title]);
    for (const m of g.metrics) rows.push([m.label, plain(m.value, m.format, view)]);
    rows.push([]);
  }
  for (const t of view.tables) {
    rows.push([t.title]);
    rows.push(t.columns.map((c) => header(c.label, c.format, view.currency)));
    for (const r of t.rows) rows.push(t.columns.map((c) => plain(r[c.key] ?? null, c.format, view)));
    if (t.rows.length === 0) rows.push([t.empty]);
    if (t.totals) rows.push(t.columns.map((c) => plain(t.totals?.[c.key] ?? null, c.format, view)));
    rows.push([]);
  }
  for (const n of view.notes) rows.push(['Note', n]);
  const width = Math.max(...rows.map((r) => r.length));
  const text = rows.map((r) => [...r, ...Array(width - r.length).fill('')].map(field).join(',')).join('\r\n');
  return new TextEncoder().encode(`﻿${text}\r\n`);
}

function plain(v: ReportValue, format: ReportFormat, view: ReportView): string {
  if (v === null || v === '') return '';
  if (typeof v === 'number') {
    if (format === 'money') return money(v).replace(/,/g, '');
    if (format === 'qty') return quantity(v).replace(/,/g, '');
    if (format === 'percent') return (v / 100).toFixed(2);
    if (format === 'int') return String(Math.round(v));
  }
  return display(v, format, view);
}

function field(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) && Number.isNaN(Number(value)) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
