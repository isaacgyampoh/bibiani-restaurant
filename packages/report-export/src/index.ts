import type { ExportFormat, ReportView } from '@rp/contracts';
import { renderCsv } from './csv';
import { fileName } from './format';
import { renderPdf } from './pdf';
import { renderXlsx } from './xlsx';

export { renderCsv } from './csv';
export { display, fileName, money } from './format';
export { renderPdf } from './pdf';
export { renderXlsx } from './xlsx';

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
};

/** Renders one report view in the requested format. */
export async function renderReport(
  view: ReportView,
  format: ExportFormat,
): Promise<{ bytes: Uint8Array; fileName: string; contentType: string }> {
  const bytes =
    format === 'pdf' ? await renderPdf(view) : format === 'xlsx' ? renderXlsx(view) : renderCsv(view);
  return { bytes, fileName: fileName(view, format), contentType: CONTENT_TYPES[format] };
}
