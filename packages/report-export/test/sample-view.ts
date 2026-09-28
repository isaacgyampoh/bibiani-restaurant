import type { ReportView } from '@rp/contracts';

/** A representative report: summary, a wide table with every value format, totals, notes, sign-off. */
export function sampleView(rows = 3): ReportView {
  return {
    kind: 'orders',
    title: 'Orders',
    restaurantName: 'Chefelisha Restaurant',
    branchName: 'Main',
    currency: 'GHS',
    timezone: 'Africa/Accra',
    period: { from: '2026-09-01', to: '2026-09-30', label: '01 September 2026 — 30 September 2026' },
    generatedAt: '2026-09-28T22:14:00.000Z',
    generatedAtLocal: '28 Sep 2026, 22:14',
    generatedBy: 'Ama Boateng',
    filters: [{ label: 'Service type', value: 'Takeaway' }],
    summary: [
      {
        title: 'Orders',
        metrics: [
          { label: 'Orders', value: rows, format: 'int' },
          { label: 'Total', value: 123450, format: 'money', emphasis: true },
          { label: 'Variance', value: -5000, format: 'money' },
        ],
      },
    ],
    tables: [
      {
        id: 'orders',
        title: 'Orders',
        columns: [
          { key: 'n', label: 'No.', format: 'int' },
          { key: 'day', label: 'Day', format: 'date' },
          { key: 'at', label: 'Opened', format: 'datetime' },
          { key: 'customer', label: 'Customer', format: 'text' },
          { key: 'note', label: 'Note', format: 'text' },
          { key: 'rate', label: 'Rate', format: 'percent' },
          { key: 'qty', label: 'Qty', format: 'qty' },
          { key: 'total', label: 'Total', format: 'money' },
        ],
        rows: Array.from({ length: rows }, (_, i) => ({
          n: i + 1,
          day: '2026-09-28',
          at: '2026-09-28T12:05:00.000Z',
          customer: i === 0 ? 'Kwame "KK" Mensah, Jr.' : i === 1 ? '=HYPERLINK("x")' : `Ɛfua Nyarkoa ${i}`,
          note:
            i === 0
              ? 'Line one\nline two with a much longer text that must wrap inside its column without clipping'
              : null,
          rate: 1500,
          qty: 1.25,
          total: 12345 * (i + 1),
        })),
        totals: { n: 'Total', total: 12345 * ((rows * (rows + 1)) / 2), qty: 1.25 * rows },
        empty: 'No orders.',
      },
      {
        id: 'empty',
        title: 'Empty table',
        columns: [{ key: 'a', label: 'A', format: 'text' }],
        rows: [],
        totals: null,
        empty: 'Nothing in this period.',
      },
    ],
    notes: ['Totals exclude cancelled and voided orders.'],
    signOff: ['Cashier signature', 'Manager signature'],
  };
}
