import type { ReportColumn, ReportFormat, ReportTable, ReportValue, ReportView } from '@rp/contracts';
import { strToU8, zipSync } from 'fflate';
import { display, header, localParts } from './format';

/**
 * A real Office Open XML workbook (.xlsx), written directly (no spreadsheet library, so it bundles
 * into the API and the hub). Sheet 1 "Summary" holds the report details and headline figures;
 * each table gets its own sheet with the report details on top, a frozen, filterable header row,
 * sensible column widths, currency / date / percent number formats and a SUBTOTAL totals row
 * (it follows the filter). Money is written in major units (GHS 12.50 → 12.5).
 */

// Cell styles (indexes into cellXfs below).
const S = {
  title: 1,
  meta: 2,
  header: 3,
  text: 4,
  int: 5,
  money: 6,
  percent: 7,
  date: 8,
  datetime: 9,
  qty: 10,
  totalText: 11,
  totalInt: 12,
  totalMoney: 13,
  totalQty: 14,
  label: 15,
  wrap: 16,
} as const;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="5">
<numFmt numFmtId="164" formatCode="#,##0.00"/>
<numFmt numFmtId="165" formatCode="0.00%"/>
<numFmt numFmtId="166" formatCode="dd mmm yyyy"/>
<numFmt numFmtId="167" formatCode="dd mmm yyyy hh:mm"/>
<numFmt numFmtId="168" formatCode="#,##0.###"/>
</numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="14"/><color rgb="FFE32129"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="10"/><color rgb="FF666E7B"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF111418"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FF111418"/></bottom><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FF111418"/></top><bottom style="double"><color rgb="FF111418"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="17">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="3" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="168" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const XML_INVALID = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(0xfffe)}${String.fromCharCode(0xffff)}]`,
  'g',
);
const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Characters XML 1.0 does not allow (control characters other than tab and line breaks).
    .replace(XML_INVALID, '');

const colName = (i: number): string => {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/** Excel date serial of a wall-clock date (1900 date system). */
const serial = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  (Date.UTC(y, mo - 1, d, h, mi) - Date.UTC(1899, 11, 30)) / 86_400_000;

type Cell = { ref: string; xml: string };

function textCell(ref: string, text: string, style: number = S.text): Cell {
  return {
    ref,
    xml: `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`,
  };
}
function numCell(ref: string, n: number, style: number): Cell {
  return { ref, xml: `<c r="${ref}" s="${style}"><v>${Number.isFinite(n) ? n : 0}</v></c>` };
}

function valueCell(ref: string, v: ReportValue, format: ReportFormat, view: ReportView): Cell | null {
  if (v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  switch (format) {
    case 'money':
      return Number.isNaN(n) ? textCell(ref, String(v)) : numCell(ref, n / 100, S.money);
    case 'int':
      return Number.isNaN(n) ? textCell(ref, String(v)) : numCell(ref, Math.round(n), S.int);
    case 'qty':
      return Number.isNaN(n) ? textCell(ref, String(v)) : numCell(ref, n, S.qty);
    case 'percent':
      return Number.isNaN(n) ? textCell(ref, String(v)) : numCell(ref, n / 10_000, S.percent);
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
      return m ? numCell(ref, serial(+m[1]!, +m[2]!, +m[3]!), S.date) : textCell(ref, String(v));
    }
    case 'datetime': {
      const p = localParts(String(v), view.timezone);
      return Number.isNaN(p.y)
        ? textCell(ref, String(v))
        : numCell(ref, serial(p.y, p.mo, p.d, p.h, p.mi), S.datetime);
    }
    default:
      return textCell(ref, String(v));
  }
}

function row(r: number, cells: (Cell | null)[], height?: number): string {
  const ht = height ? ` ht="${height}" customHeight="1"` : '';
  return `<row r="${r}"${ht}>${cells
    .filter((c): c is Cell => c !== null)
    .map((c) => c.xml)
    .join('')}</row>`;
}

function sheetXml(opts: {
  rows: string[];
  widths: number[];
  freezeRow?: number;
  autoFilter?: string;
  landscape: boolean;
  merges?: string[];
}): string {
  const pane = opts.freezeRow
    ? `<pane ySplit="${opts.freezeRow}" topLeftCell="A${opts.freezeRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${opts.freezeRow + 1}" sqref="A${opts.freezeRow + 1}"/>`
    : '';
  const cols = opts.widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0">${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols ? `<cols>${cols}</cols>` : ''}
<sheetData>${opts.rows.join('')}</sheetData>
${opts.autoFilter ? `<autoFilter ref="${opts.autoFilter}"/>` : ''}
${opts.merges?.length ? `<mergeCells count="${opts.merges.length}">${opts.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="${opts.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter>&amp;LMY FOOD&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter>
</worksheet>`;
}

/** Table sheets: three rows of report details, a blank row, then the header row. */
const HEADER_ROW = 5;

/** The report details at the top of every sheet. Returns the next free row (HEADER_ROW). */
function metaRows(view: ReportView, out: string[], title: string): number {
  let r = 1;
  out.push(row(r++, [textCell('A1', `${view.restaurantName.toUpperCase()} — ${title}`, S.title)], 20));
  out.push(row(r, [textCell(`A${r}`, `MY FOOD · ${view.branchName} · ${view.period.label}`, S.meta)]));
  r++;
  const filters = view.filters.map((f) => `${f.label}: ${f.value}`).join(' · ');
  out.push(
    row(r, [
      textCell(
        `A${r}`,
        `Generated ${view.generatedAtLocal}${view.generatedBy ? ` by ${view.generatedBy}` : ''} (${view.timezone}) · Amounts in ${view.currency}${filters ? ` · ${filters}` : ''}`,
        S.meta,
      ),
    ]),
  );
  return HEADER_ROW;
}

const width = (c: ReportColumn, t: ReportTable, view: ReportView): number => {
  const head = header(c.label, c.format, view.currency).length;
  const sample = t.rows.slice(0, 300).map((r) => display(r[c.key] ?? null, c.format, view).length);
  const longest = Math.max(
    head,
    ...sample,
    t.totals ? display(t.totals[c.key] ?? null, c.format, view).length : 0,
  );
  return Math.min(Math.max(longest + 2, c.format === 'text' ? 10 : 12), c.format === 'text' ? 48 : 22);
};

function tableSheet(view: ReportView, t: ReportTable): string {
  const out: string[] = [];
  const headerRow = metaRows(view, out, t.title);
  const last = colName(t.columns.length - 1);
  out.push(
    row(
      headerRow,
      t.columns.map((c, i) =>
        textCell(`${colName(i)}${headerRow}`, header(c.label, c.format, view.currency), S.header),
      ),
      30,
    ),
  );
  let r = headerRow + 1;
  for (const data of t.rows) {
    out.push(
      row(
        r,
        t.columns.map((c, i) => valueCell(`${colName(i)}${r}`, data[c.key] ?? null, c.format, view)),
      ),
    );
    r++;
  }
  if (t.rows.length === 0) out.push(row(r++, [textCell(`A${r - 1}`, t.empty, S.meta)]));
  const lastData = r - 1;
  if (t.totals && t.rows.length > 0) {
    const totals = t.totals;
    out.push(
      row(
        r,
        t.columns.map((c, i) => {
          const ref = `${colName(i)}${r}`;
          const v = totals[c.key];
          if (i === 0) return textCell(ref, typeof v === 'string' ? v : 'Total', S.totalText);
          if (v === null || v === undefined || typeof v !== 'number') return textCell(ref, '', S.totalText);
          const range = `${colName(i)}${headerRow + 1}:${colName(i)}${lastData}`;
          const style = c.format === 'money' ? S.totalMoney : c.format === 'qty' ? S.totalQty : S.totalInt;
          const cached = c.format === 'money' ? v / 100 : v;
          // SUBTOTAL(109, …) sums only the rows the filter shows.
          return { ref, xml: `<c r="${ref}" s="${style}"><f>SUBTOTAL(109,${range})</f><v>${cached}</v></c>` };
        }),
      ),
    );
  }
  return sheetXml({
    rows: out,
    widths: t.columns.map((c) => width(c, t, view)),
    freezeRow: headerRow,
    autoFilter: t.rows.length > 0 ? `A${headerRow}:${last}${lastData}` : undefined,
    landscape: t.columns.length > 6,
  });
}

function summarySheet(view: ReportView): string {
  const out: string[] = [];
  let r = metaRows(view, out, view.title);
  for (const f of view.filters) {
    out.push(row(r, [textCell(`A${r}`, f.label, S.label), textCell(`B${r}`, f.value)]));
    r++;
  }
  if (view.filters.length) r++;
  for (const g of view.summary) {
    out.push(row(r, [textCell(`A${r}`, g.title, S.header), textCell(`B${r}`, '', S.header)]));
    r++;
    for (const m of g.metrics) {
      const label = m.format === 'money' ? `${m.label} (${view.currency})` : m.label;
      out.push(
        row(r, [
          textCell(`A${r}`, label, m.emphasis ? S.label : S.text),
          valueCell(`B${r}`, m.value, m.format, view),
        ]),
      );
      r++;
    }
    r++;
  }
  if (view.notes.length) {
    out.push(row(r, [textCell(`A${r}`, 'Notes', S.label)]));
    r++;
    for (const n of view.notes) {
      out.push(row(r, [textCell(`A${r}`, n, S.wrap)], Math.min(15 * Math.ceil(n.length / 90) + 2, 120)));
      r++;
    }
  }
  if (view.signOff.length) {
    r++;
    for (const s of view.signOff) {
      out.push(row(r, [textCell(`A${r}`, s, S.label), textCell(`B${r}`, '______________________________')]));
      r += 2;
    }
  }
  return sheetXml({ rows: out, widths: [46, 24, 14, 14], landscape: false });
}

function sheetName(title: string, used: Set<string>): string {
  const base =
    title
      .replace(/[[\]:*?/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 28) || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 26)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

export function renderXlsx(view: ReportView): Uint8Array {
  const used = new Set<string>();
  const sheets = [
    { name: sheetName('Summary', used), xml: summarySheet(view) },
    ...view.tables.map((t) => ({ name: sheetName(t.title, used), xml: tableSheet(view, t), table: t })),
  ];
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, text: string) => {
    files[path] = strToU8(text);
  };
  put(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
  );
  put(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  );
  put(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(`${view.title} — ${view.period.label}`)}</dc:title>
<dc:creator>MY FOOD</dc:creator>
<dc:subject>${esc(view.restaurantName)}</dc:subject>
<dcterms:created xsi:type="dcterms:W3CDTF">${view.generatedAt.replace(/\.\d+Z$/, 'Z')}</dcterms:created>
</cp:coreProperties>`,
  );
  put(
    'docProps/app.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>MY FOOD</Application></Properties>`,
  );
  put(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView activeTab="0"/></bookViews>
<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${sheets
      .map((s, i) => {
        const t = 'table' in s ? s.table : null;
        if (!t || t.rows.length === 0) return '';
        const headerRow = HEADER_ROW;
        return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(s.name).replace(/'/g, "''")}'!$A$${headerRow}:$${colName(t.columns.length - 1)}$${headerRow + t.rows.length}</definedName>`;
      })
      .join('')}</definedNames>
</workbook>`,
  );
  put(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  put('xl/styles.xml', STYLES);
  sheets.forEach((s, i) => {
    put(`xl/worksheets/sheet${i + 1}.xml`, s.xml);
  });
  return zipSync(files, { level: 6 });
}
