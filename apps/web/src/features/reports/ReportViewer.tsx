import type { ExportFormat, ReportFormat, ReportTable, ReportValue, ReportView } from '@rp/contracts';
import { formatMinor } from '@rp/domain';
import { useEffect, useRef, useState } from 'react';
import { errorMessage, useToast } from '../../ui/components';

/**
 * Renders any report (a ReportView computed on the server) the same way everywhere: headline
 * figures as cards, then each table as a collapsible section. On phones, tables scroll inside
 * their section and long ones start collapsed; the PDF / Excel / CSV exports contain exactly
 * this data.
 */
export function ReportViewer({
  view,
  collapseTables = false,
}: {
  view: ReportView;
  collapseTables?: boolean;
}) {
  return (
    <div className="report">
      {view.filters.length ? (
        <div className="report-filters">
          {view.filters.map((f) => (
            <span key={f.label} className="chip">
              {f.label}: <strong>{f.value}</strong>
            </span>
          ))}
        </div>
      ) : null}
      {view.summary.map((g) => (
        <section key={g.title} className="report-group" aria-label={g.title}>
          <h3>{g.title}</h3>
          <div className="report-metrics">
            {g.metrics.map((m) => (
              <div
                key={m.label}
                className={`report-metric ${m.emphasis ? 'emphasis' : ''} ${tone(m.value, m.label)}`}
              >
                <span className="label">{m.label}</span>
                <span className="value">{cell(m.value, m.format, view)}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
      {view.tables.map((t) => (
        <ReportTableSection
          key={t.id}
          table={t}
          view={view}
          startOpen={!collapseTables || t.rows.length <= 8}
        />
      ))}
      {view.notes.length ? (
        <div className="report-notes">
          {view.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      ) : null}
      <p className="report-generated">
        {view.restaurantName} · {view.branchName} · generated {view.generatedAtLocal}
        {view.generatedBy ? ` by ${view.generatedBy}` : ''} · times in {view.timezone}
      </p>
    </div>
  );
}

function ReportTableSection({
  table,
  view,
  startOpen,
}: {
  table: ReportTable;
  view: ReportView;
  startOpen: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const numeric = (f: ReportFormat) => f === 'money' || f === 'int' || f === 'qty' || f === 'percent';
  return (
    <section className="report-table card">
      <button type="button" className="report-table-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <strong>{table.title}</strong>
        <span className="muted small">
          {table.rows.length} {table.rows.length === 1 ? 'row' : 'rows'}
        </span>
        <span className={`chev ${open ? 'open' : ''}`} aria-hidden>
          ›
        </span>
      </button>
      {open ? (
        table.rows.length === 0 ? (
          <p className="muted report-empty">{table.empty}</p>
        ) : (
          <div className="table-wrap">
            <table className="list report-list">
              <thead>
                <tr>
                  {table.columns.map((c) => (
                    <th key={c.key} className={numeric(c.format) ? 'num' : ''}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.slice(0, 500).map((r, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: report rows have no stable id
                  <tr key={i}>
                    {table.columns.map((c) => (
                      <td key={c.key} className={numeric(c.format) ? 'num' : ''}>
                        {cell(r[c.key] ?? null, c.format, view)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {table.totals ? (
                <tfoot>
                  <tr>
                    {table.columns.map((c) => (
                      <td key={c.key} className={numeric(c.format) ? 'num' : ''}>
                        {cell(table.totals?.[c.key] ?? null, c.format, view)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              ) : null}
            </table>
            {table.rows.length > 500 ? (
              <p className="muted small report-empty">
                Showing the first 500 of {table.rows.length} rows. The export contains all of them.
              </p>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function cell(
  v: ReportValue,
  format: ReportFormat,
  view: Pick<ReportView, 'currency' | 'timezone'>,
): string {
  if (v === null || v === '') return '—';
  if (typeof v === 'string' && ['money', 'int', 'qty', 'percent'].includes(format) && Number.isNaN(Number(v)))
    return v;
  switch (format) {
    case 'money':
      return formatMinor(Number(v), view.currency);
    case 'int':
      return Math.round(Number(v)).toLocaleString('en-US');
    case 'qty':
      return Number(Number(v).toFixed(3)).toLocaleString('en-US', { maximumFractionDigits: 3 });
    case 'percent':
      return `${(Number(v) / 100).toFixed(2)}%`;
    case 'date': {
      const [y, m, d] = String(v).slice(0, 10).split('-');
      return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
    }
    case 'datetime':
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: view.timezone,
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(String(v)));
    default:
      return String(v);
  }
}

/** Variance-style figures get a tone: short (negative) in red, over in amber. */
function tone(v: ReportValue, label: string): string {
  if (!/variance/i.test(label) || typeof v !== 'number' || v === 0) return '';
  return v < 0 ? 'neg' : 'pos';
}

/** Saves a downloaded file with its name (works on phones: opens the share / files sheet). */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const FORMATS: { format: ExportFormat; label: string; hint: string }[] = [
  { format: 'pdf', label: 'PDF', hint: 'Printable document' },
  { format: 'xlsx', label: 'Excel', hint: 'Spreadsheet (.xlsx)' },
  { format: 'csv', label: 'CSV', hint: 'Plain data for other programs' },
];

/**
 * Export button: a menu on wide screens, a bottom sheet on phones. Shows progress, confirms the
 * download, and explains failures in plain words. One export at a time.
 */
export function ExportMenu({
  onExport,
  disabled,
}: {
  onExport: (format: ExportFormat) => Promise<{ blob: Blob; fileName: string }>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  async function run(format: ExportFormat) {
    setBusy(format);
    setError(null);
    try {
      const file = await onExport(format);
      saveFile(file.blob, file.fileName);
      toast(`Downloaded ${file.fileName}`);
      setOpen(false);
    } catch (e) {
      setError(
        errorMessage(e).includes('permission')
          ? 'You do not have permission to export this report.'
          : `The export did not complete: ${errorMessage(e)}`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="export-menu" ref={ref}>
      <button
        type="button"
        className="btn primary"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setError(null);
          setOpen(!open);
        }}
      >
        Export
      </button>
      {open ? (
        <>
          <div className="export-scrim" aria-hidden onClick={() => !busy && setOpen(false)} />
          <div className="export-pop" role="menu" aria-label="Export as">
            <div className="export-title">Export this report</div>
            {FORMATS.map((f) => (
              <button
                key={f.format}
                type="button"
                role="menuitem"
                className="export-item"
                disabled={busy !== null}
                onClick={() => void run(f.format)}
              >
                <strong>{busy === f.format ? `Preparing ${f.label}…` : f.label}</strong>
                <span>{f.hint}</span>
              </button>
            ))}
            {error ? (
              <div className="error" role="alert">
                {error}
              </div>
            ) : null}
            <button
              type="button"
              className="btn export-cancel"
              disabled={busy !== null}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
