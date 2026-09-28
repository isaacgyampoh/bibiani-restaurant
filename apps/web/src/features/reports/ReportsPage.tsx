import type { MeView, ReportFilterOptionsView, ReportKind, ReportQuery, ReportView } from '@rp/contracts';
import { REPORT_KINDS } from '@rp/contracts';
import { useEffect, useMemo, useState } from 'react';
import { linkTo, navigate, useLocation } from '../../infra/router';
import { api, hasPermission } from '../../infra/session';
import { ErrorBox, Field } from '../../ui/components';
import { Shell, Skeleton } from '../../ui/Shell';
import { ExportMenu, ReportViewer } from './ReportViewer';
import { SalesOverviewPage } from './SalesOverviewPage';

type FilterKey =
  | 'staffId'
  | 'method'
  | 'channel'
  | 'deviceId'
  | 'tableId'
  | 'categoryId'
  | 'productId'
  | 'movementKind'
  | 'orderStatus'
  | 'sort';

interface ReportInfo {
  kind: ReportKind;
  title: string;
  description: string;
  group: 'Sales' | 'Staff' | 'Customers' | 'Inventory';
  filters: FilterKey[];
  /** Period does not apply (stock on hand now). */
  noPeriod?: boolean;
}

export const REPORTS: ReportInfo[] = [
  {
    kind: 'end_of_day',
    group: 'Sales',
    title: 'End of Day',
    description:
      'The whole trading day: sales, payments, service types, staff, terminals, voids, bills and registers.',
    filters: ['channel', 'staffId', 'deviceId', 'method'],
  },
  {
    kind: 'tax',
    group: 'Sales',
    title: 'Tax',
    description: 'Gross, discounts, net, taxable sales and tax by configured rate.',
    filters: ['channel', 'categoryId', 'productId', 'staffId'],
  },
  {
    kind: 'items',
    group: 'Sales',
    title: 'Item Sales',
    description: 'Quantity, gross, discounts, net and average price per item and category.',
    filters: ['channel', 'method', 'categoryId', 'productId', 'staffId', 'tableId', 'sort'],
  },
  {
    kind: 'payment_methods',
    group: 'Sales',
    title: 'Payment Methods',
    description: 'Cash, MoMo and card: payments, refunds, net, and split payments.',
    filters: ['channel', 'method', 'deviceId', 'staffId'],
  },
  {
    kind: 'service_types',
    group: 'Sales',
    title: 'Dine-in and Takeaway',
    description: 'Orders and sales by service type.',
    filters: ['categoryId', 'productId', 'staffId'],
  },
  {
    kind: 'terminals',
    group: 'Sales',
    title: 'Sales by Terminal',
    description: 'Orders and payments per till, by payment method.',
    filters: ['channel', 'method', 'deviceId', 'staffId'],
  },
  {
    kind: 'orders',
    group: 'Sales',
    title: 'Orders',
    description: 'Every order with who took it, who sent it, who took payment, and totals.',
    filters: ['orderStatus', 'channel', 'method', 'staffId', 'tableId', 'deviceId'],
  },
  {
    kind: 'sales_by_staff',
    group: 'Staff',
    title: 'Sales by Staff',
    description: 'Order staff, kitchen sender and cashier kept separate.',
    filters: ['staffId', 'channel', 'method', 'categoryId', 'productId'],
  },
  {
    kind: 'staff_activity',
    group: 'Staff',
    title: 'Staff Activity',
    description: 'Orders, kitchen sends, payments, bills, voids, discounts and registers per person.',
    filters: ['staffId', 'channel'],
  },
  {
    kind: 'customers',
    group: 'Customers',
    title: 'Customers',
    description: 'Customers who ordered, new and returning customers, orders and spend.',
    filters: ['channel'],
  },
  {
    kind: 'inventory_valuation',
    group: 'Inventory',
    title: 'Inventory Valuation',
    description: 'Stock on hand now, at cost.',
    filters: [],
    noPeriod: true,
  },
  {
    kind: 'stock_movements',
    group: 'Inventory',
    title: 'Stock Movements',
    description: 'Every stock change with before and after quantities.',
    filters: ['movementKind', 'staffId'],
  },
  {
    kind: 'deliveries',
    group: 'Inventory',
    title: 'Deliveries',
    description: 'Stock received: quantities, cost, supplier / invoice reference.',
    filters: ['staffId'],
  },
  {
    kind: 'wastage',
    group: 'Inventory',
    title: 'Wastage',
    description: 'Stock written off, with reasons and value.',
    filters: ['staffId'],
  },
  {
    kind: 'adjustments',
    group: 'Inventory',
    title: 'Adjustments',
    description: 'Manual adjustments and approved stock-take corrections.',
    filters: ['staffId'],
  },
  {
    kind: 'stock_takes',
    group: 'Inventory',
    title: 'Stock Taking',
    description: 'Expected, counted and variance per item.',
    filters: [],
  },
  {
    kind: 'recipe_consumption',
    group: 'Inventory',
    title: 'Recipe Consumption',
    description: 'Ingredients used by sales and their cost.',
    filters: ['channel'],
  },
];

const PRESETS: { id: ReportQuery['preset']; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'this_week', label: 'This week' },
  { id: 'this_month', label: 'This month' },
  { id: 'custom', label: 'Custom' },
];

function canSee(me: MeView, r: ReportInfo): boolean {
  if (r.group === 'Inventory')
    return hasPermission(me, 'reports.view') || hasPermission(me, 'inventory.manage');
  if (r.group === 'Customers') return hasPermission(me, 'reports.view') && hasPermission(me, 'customer.view');
  return hasPermission(me, 'reports.view');
}

export function ReportsPage({ me }: { me: MeView }) {
  const { path } = useLocation();
  const kind = path.split('/')[2] ?? '';
  if (kind === 'overview') return <SalesOverviewPage me={me} />;
  const info = REPORTS.find((r) => r.kind === kind);
  if (info && REPORT_KINDS.includes(info.kind) && canSee(me, info))
    return <ReportScreen me={me} info={info} key={kind} />;
  return <Catalogue me={me} />;
}

function Catalogue({ me }: { me: MeView }) {
  const groups = ['Sales', 'Staff', 'Customers', 'Inventory'] as const;
  return (
    <Shell
      me={me}
      title="Reports"
      subtitle="Choose a report. Every report can be exported as PDF, Excel or CSV."
    >
      {groups.map((g) => {
        const items = REPORTS.filter((r) => r.group === g && canSee(me, r));
        if (items.length === 0) return null;
        return (
          <section key={g} className="report-catalogue">
            <h2>{g}</h2>
            <div className="catalogue-grid">
              {items.map((r) => (
                <a
                  key={r.kind}
                  className="catalogue-item"
                  href={`/reports/${r.kind}`}
                  onClick={linkTo(`/reports/${r.kind}`)}
                >
                  <strong>{r.title}</strong>
                  <span>{r.description}</span>
                </a>
              ))}
              {g === 'Sales' && hasPermission(me, 'reports.view') ? (
                <a className="catalogue-item" href="/reports/overview" onClick={linkTo('/reports/overview')}>
                  <strong>Sales overview</strong>
                  <span>Charts: sales by day and hour, best sellers, kitchen speed.</span>
                </a>
              ) : null}
              {g === 'Sales' &&
              (hasPermission(me, 'register.manage') || hasPermission(me, 'register.operate')) ? (
                <a className="catalogue-item" href="/register" onClick={linkTo('/register')}>
                  <strong>Cash registers</strong>
                  <span>Openings, closings, expected and counted cash, variances.</span>
                </a>
              ) : null}
            </div>
          </section>
        );
      })}
    </Shell>
  );
}

function ReportScreen({ me, info }: { me: MeView; info: ReportInfo }) {
  const branchId = me.branches[0]?.id ?? '';
  const [q, setQ] = useState<ReportQuery>({ branchId, preset: 'today' });
  const [view, setView] = useState<ReportView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [options, setOptions] = useState<ReportFilterOptionsView | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    if (info.filters.length)
      api
        .reportOptions(branchId)
        .then(setOptions)
        .catch(() => setOptions(null));
  }, [branchId, info.filters.length]);

  useEffect(() => {
    if (q.preset === 'custom' && (!q.from || !q.to)) return;
    let current = true;
    setLoading(true);
    setError(null);
    api
      .report(info.kind, q)
      .then((v) => current && setView(v))
      .catch((e) => current && setError(e))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [info.kind, q]);

  const active = info.filters.filter((k) => q[k]);
  const today = options?.today ?? new Date().toISOString().slice(0, 10);

  return (
    <Shell
      me={me}
      title={info.title}
      subtitle={
        <>
          <a href="/reports" onClick={linkTo('/reports')}>
            Reports
          </a>
          <span>{view ? view.period.label : ' '}</span>
        </>
      }
      actions={
        <ExportMenu
          disabled={!view || loading}
          onExport={(format) => api.exportReport(info.kind, q, format)}
        />
      }
    >
      <div className="report-toolbar">
        {info.noPeriod ? null : (
          <fieldset className="seg light period" aria-label="Period">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={q.preset === p.id ? 'on' : ''}
                aria-pressed={q.preset === p.id}
                onClick={() =>
                  setQ({
                    ...q,
                    preset: p.id,
                    ...(p.id === 'custom'
                      ? { from: q.from ?? view?.period.from ?? today, to: q.to ?? view?.period.to ?? today }
                      : {}),
                  })
                }
              >
                {p.label}
              </button>
            ))}
          </fieldset>
        )}
        {q.preset === 'custom' && !info.noPeriod ? (
          <div className="row custom-range">
            <input
              type="date"
              aria-label="From"
              value={q.from ?? ''}
              max={q.to ?? undefined}
              onChange={(e) => setQ({ ...q, from: e.target.value })}
            />
            <span className="muted">to</span>
            <input
              type="date"
              aria-label="To"
              value={q.to ?? ''}
              min={q.from ?? undefined}
              onChange={(e) => setQ({ ...q, to: e.target.value })}
            />
          </div>
        ) : null}
        {info.filters.length ? (
          <button
            type="button"
            className={`btn ${active.length ? 'on' : ''}`}
            onClick={() => setFiltersOpen(true)}
          >
            Filters{active.length ? ` (${active.length})` : ''}
          </button>
        ) : null}
        {active.length ? (
          <button
            type="button"
            className="link"
            onClick={() => setQ({ branchId, preset: q.preset, from: q.from, to: q.to })}
          >
            Clear filters
          </button>
        ) : null}
      </div>
      <ErrorBox error={error} />
      {loading && !view ? <Skeleton rows={8} /> : null}
      {view ? (
        <div className={loading ? 'report-loading' : ''} aria-busy={loading}>
          <ReportViewer view={view} collapseTables />
        </div>
      ) : null}
      {filtersOpen ? (
        <FilterSheet
          info={info}
          q={q}
          options={options}
          onClose={() => setFiltersOpen(false)}
          onApply={(next) => {
            setQ(next);
            setFiltersOpen(false);
          }}
        />
      ) : null}
    </Shell>
  );
}

const MOVEMENTS: [string, string][] = [
  ['receive', 'Deliveries'],
  ['waste', 'Wastage'],
  ['adjust', 'Adjustments'],
  ['count', 'Stock takes'],
  ['sale', 'Sales (recipes)'],
  ['sale_reversal', 'Sales reversed'],
];

function FilterSheet({
  info,
  q,
  options,
  onClose,
  onApply,
}: {
  info: ReportInfo;
  q: ReportQuery;
  options: ReportFilterOptionsView | null;
  onClose: () => void;
  onApply: (q: ReportQuery) => void;
}) {
  const [draft, setDraft] = useState<ReportQuery>(q);
  const has = (k: FilterKey) => info.filters.includes(k);
  const set = (k: FilterKey, v: string) => setDraft({ ...draft, [k]: v || null });
  const products = useMemo(
    () => (options?.products ?? []).filter((p) => !draft.categoryId || p.categoryId === draft.categoryId),
    [options, draft.categoryId],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const select = (k: FilterKey, label: string, choices: [string, string][], any = 'All') =>
    has(k) ? (
      <Field label={label}>
        <select
          value={(draft[k] as string | null | undefined) ?? ''}
          onChange={(e) => set(k, e.target.value)}
        >
          <option value="">{any}</option>
          {choices.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Field>
    ) : null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: tapping outside closes; Escape and Cancel do too
    <div
      className="sheet-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="sheet filter-sheet" role="dialog" aria-modal="true" aria-label="Filters">
        <div className="sheet-grip" aria-hidden />
        <h2>Filters</h2>
        {options === null &&
        info.filters.some((k) =>
          ['staffId', 'deviceId', 'tableId', 'categoryId', 'productId'].includes(k),
        ) ? (
          <p className="muted small">Loading choices…</p>
        ) : null}
        {select('orderStatus', 'Order status', [
          ['completed', 'Completed'],
          ['open', 'Open'],
          ['cancelled', 'Cancelled / voided'],
        ])}
        {select('channel', 'Service type', [
          ['dine_in', 'Dine-in'],
          ['takeaway', 'Takeaway'],
        ])}
        {select('method', 'Payment method', [
          ['cash', 'Cash'],
          ['momo', 'MoMo'],
          ['card', 'Card'],
        ])}
        {select(
          'staffId',
          'Staff',
          (options?.staff ?? []).map((s) => [s.id, s.role ? `${s.name} (${s.role})` : s.name]),
          'Everyone',
        )}
        {select(
          'deviceId',
          'Terminal',
          (options?.terminals ?? []).map((t) => [t.id, t.name]),
        )}
        {select(
          'tableId',
          'Table',
          (options?.tables ?? []).map((t) => [t.id, `Table ${t.label}`]),
        )}
        {select(
          'categoryId',
          'Category',
          (options?.categories ?? []).map((c) => [c.id, c.name]),
        )}
        {select(
          'productId',
          'Item',
          products.map((p) => [p.id, p.name]),
        )}
        {select('movementKind', 'Movement type', MOVEMENTS)}
        {select(
          'sort',
          'Sort by',
          [
            ['sales', 'Net sales (highest first)'],
            ['quantity', 'Quantity (most first)'],
            ['name', 'Name (A–Z)'],
          ],
          'Net sales (highest first)',
        )}
        <div className="sheet-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => onApply(draft)}>
            Show results
          </button>
        </div>
      </div>
    </div>
  );
}

export const reportPath = (kind: ReportKind) => `/reports/${kind}`;
export const openReport = (kind: ReportKind) => navigate(reportPath(kind));
