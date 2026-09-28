import type {
  ExportFormat,
  RegisterSessionView,
  ReportColumn,
  ReportFilterOptionsView,
  ReportKind,
  ReportMetric,
  ReportQuery,
  ReportTable,
  ReportView,
} from '@rp/contracts';
import { businessDay, DomainError, describePeriod, resolvePeriod } from '@rp/domain';
import type { ReportFilter, ReportRepository, ReportRow, Repositories } from '../ports';
import { authorize, can, canAnywhere, type RequestContext } from '../principal';
import { GetRegister } from './registers';
import type { Dependencies } from './shared';

/**
 * Reports. Each report is computed ONCE here, from the report repository's aggregates, into a
 * ReportView: the Reports screen and the PDF, Excel and CSV exports all render that same object,
 * so what is on screen is what is exported.
 */

export const REPORT_TITLES: Record<ReportKind | 'register_closing', string> = {
  end_of_day: 'End of Day',
  tax: 'Tax Report',
  items: 'Item Sales',
  payment_methods: 'Sales by Payment Method',
  service_types: 'Sales by Service Type',
  terminals: 'Sales by Terminal',
  sales_by_staff: 'Sales by Staff',
  staff_activity: 'Staff Activity',
  orders: 'Orders',
  customers: 'Customers',
  inventory_valuation: 'Inventory Valuation',
  stock_movements: 'Stock Movements',
  deliveries: 'Deliveries (Stock Received)',
  wastage: 'Wastage',
  adjustments: 'Stock Adjustments',
  stock_takes: 'Stock Taking',
  recipe_consumption: 'Recipe Consumption',
  register_closing: 'Cashier Register Closing',
};

const INVENTORY_KINDS = new Set<ReportKind>([
  'inventory_valuation',
  'stock_movements',
  'deliveries',
  'wastage',
  'adjustments',
  'stock_takes',
  'recipe_consumption',
]);

const METHOD: Record<string, string> = { cash: 'Cash', momo: 'MoMo', card: 'Card' };
const CHANNEL: Record<string, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway' };
const MOVEMENT: Record<string, string> = {
  receive: 'Delivery / received',
  waste: 'Wastage',
  adjust: 'Adjustment',
  count: 'Stock take',
  sale: 'Sale (recipe)',
  sale_reversal: 'Sale reversed',
};
const STATUS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Sent',
  in_preparation: 'Preparing',
  partially_ready: 'Partly ready',
  ready: 'Ready',
  served: 'Served',
  picked_up: 'Picked up',
  completed: 'Completed',
  cancelled: 'Cancelled',
  voided: 'Voided',
};
const PAY_STATUS: Record<string, string> = {
  unpaid: 'Unpaid',
  partially_paid: 'Part paid',
  paid: 'Paid',
  partially_refunded: 'Part refunded',
  refunded: 'Refunded',
};

const num = (v: ReportRow[string] | undefined) => (typeof v === 'number' ? v : v ? Number(v) : 0);
/** A report row with extra (derived) columns. */
const ext = (x: ReportRow, extra: Record<string, ReportRow[string] | undefined>): ReportRow => {
  const out: ReportRow = { ...x };
  for (const [k, v] of Object.entries(extra)) out[k] = v ?? null;
  return out;
};
const col = (key: string, label: string, format: ReportColumn['format'] = 'text'): ReportColumn => ({
  key,
  label,
  format,
});
const m = (
  label: string,
  value: ReportMetric['value'],
  format: ReportMetric['format'] = 'money',
  emphasis = false,
) => (emphasis ? { label, value, format, emphasis } : { label, value, format });
/** Sums the given columns of the rows into a totals row labelled in `labelKey`. */
function totals(rows: ReportRow[], labelKey: string, keys: string[]): ReportRow | null {
  if (rows.length === 0) return null;
  const t: ReportRow = { [labelKey]: 'Total' };
  for (const k of keys) t[k] = rows.reduce((n, r) => n + num(r[k]), 0);
  return t;
}
const table = (
  id: string,
  title: string,
  columns: ReportColumn[],
  rows: ReportRow[],
  total: ReportRow | null,
  empty = 'Nothing in this period.',
): ReportTable => ({ id, title, columns, rows, totals: total, empty });

interface Built {
  summary: ReportView['summary'];
  tables: ReportTable[];
  notes: string[];
  signOff?: string[];
}

export class GetReport {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, kind: ReportKind, q: ReportQuery): Promise<ReportView> {
    authorizeReport(ctx, kind, q.branchId);
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const c = await tx.reports.context(q.branchId);
      if (!c) throw new DomainError('NOT_FOUND', 'Branch not found');
      const period = resolvePeriod(q.preset, now, c.timezone, c.cutoff, { from: q.from, to: q.to });
      const f: ReportFilter = {
        branchId: q.branchId,
        ...period,
        staffId: q.staffId ?? null,
        method: q.method ?? null,
        channel: q.channel ?? null,
        deviceId: q.deviceId ?? null,
        tableId: q.tableId ?? null,
        categoryId: q.categoryId ?? null,
        productId: q.productId ?? null,
        movementKind: q.movementKind ?? null,
        orderStatus: q.orderStatus ?? null,
      };
      const built = await buildReport(tx.reports, kind, f, q, c.currency);
      return {
        kind,
        title: REPORT_TITLES[kind],
        restaurantName: c.restaurantName,
        branchName: c.branchName,
        currency: c.currency,
        timezone: c.timezone,
        period: {
          ...period,
          label:
            kind === 'inventory_valuation'
              ? `Stock on hand at ${localStamp(now, c.timezone)}`
              : describePeriod(period.from, period.to),
        },
        generatedAt: now.toISOString(),
        generatedAtLocal: localStamp(now, c.timezone),
        generatedBy: await staffName(tx, ctx),
        filters: await describeFilters(tx.reports, q),
        summary: built.summary,
        tables: built.tables,
        notes: built.notes,
        signOff: built.signOff ?? [],
      };
    });
  }
}

/** Everything the filters can offer (staff, terminals, tables, categories, products). */
export class GetReportFilterOptions {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, branchId: string): Promise<ReportFilterOptionsView> {
    if (!can(ctx.principal, 'inventory.manage', branchId)) authorize(ctx.principal, 'reports.view', branchId);
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const c = await tx.reports.context(branchId);
      if (!c) throw new DomainError('NOT_FOUND', 'Branch not found');
      return {
        ...(await tx.reports.filterOptions(branchId)),
        timezone: c.timezone,
        today: businessDay(now, c.timezone, c.cutoff),
      };
    });
  }
}

/**
 * An export: the same ReportView as the screen, and an audit record of who exported what, with
 * which filters, in which format, from which device. Rendering to PDF / XLSX / CSV is done by
 * the caller (presentation), from this view.
 */
export class ExportReport {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    kind: ReportKind | 'register_closing',
    format: ExportFormat,
    q: ReportQuery | { branchId: string; sessionId: string },
  ): Promise<ReportView> {
    const view =
      kind === 'register_closing'
        ? await new GetRegisterClosingReport(this.deps).execute(ctx, (q as { sessionId: string }).sessionId)
        : await new GetReport(this.deps).execute(ctx, kind, q as ReportQuery);
    await this.deps.uow.run(ctx.principal.restaurantId, (tx) =>
      tx.audit.append({
        branchId: q.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'report.export',
        entityType: 'report',
        entityId: kind,
        after: {
          report: view.title,
          format,
          period: view.period,
          filters: view.filters,
          rows: view.tables.reduce((n, t) => n + t.rows.length, 0),
        },
        correlationId: ctx.correlationId,
      }),
    );
    return view;
  }
}

/** The cashier's closing report for one register session (their own, or any with register.manage). */
export class GetRegisterClosingReport {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, sessionId: string): Promise<ReportView> {
    const r = await new GetRegister(this.deps).execute(ctx, sessionId);
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const c = (await tx.reports.context(r.branchId))!;
      const closing = registerClosing(r, await tx.reports.registerOrders(sessionId), c.timezone);
      return {
        kind: 'register_closing',
        title: REPORT_TITLES.register_closing,
        restaurantName: c.restaurantName,
        branchName: c.branchName,
        currency: c.currency,
        timezone: c.timezone,
        period: {
          from: businessDay(new Date(r.openedAt), c.timezone, c.cutoff),
          to: businessDay(r.closedAt ? new Date(r.closedAt) : now, c.timezone, c.cutoff),
          label: `${localStamp(new Date(r.openedAt), c.timezone)} — ${r.closedAt ? localStamp(new Date(r.closedAt), c.timezone) : 'still open'}`,
        },
        generatedAt: now.toISOString(),
        generatedAtLocal: localStamp(now, c.timezone),
        generatedBy: await staffName(tx, ctx),
        filters: [],
        ...closing,
        signOff: closing.signOff ?? [],
      };
    });
  }
}

function authorizeReport(ctx: RequestContext, kind: ReportKind, branchId: string): void {
  if (INVENTORY_KINDS.has(kind) && can(ctx.principal, 'inventory.manage', branchId)) return;
  authorize(ctx.principal, 'reports.view', branchId);
  // Customer details are private: the customer report also needs customer.view.
  if (kind === 'customers' && !canAnywhere(ctx.principal, 'customer.view'))
    throw new DomainError('FORBIDDEN', 'You do not have permission to see customer details');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "28 Sep 2026, 22:14" in the restaurant's timezone. */
function localStamp(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${MONTHS[Number(get('month')) - 1]} ${get('year')}, ${get('hour')}:${get('minute')}`;
}

async function staffName(tx: Repositories, ctx: RequestContext): Promise<string | null> {
  return ctx.principal.staffId ? (await tx.registers.names(ctx.principal.staffId, null)).staff : null;
}

async function describeFilters(
  reports: ReportRepository,
  q: ReportQuery,
): Promise<{ label: string; value: string }[]> {
  const out: { label: string; value: string }[] = [];
  const needsNames = q.staffId || q.deviceId || q.tableId || q.categoryId || q.productId;
  const o = needsNames ? await reports.filterOptions(q.branchId) : null;
  const name = <T extends { id: string }>(list: T[] | undefined, id: string, get: (t: T) => string) => {
    const hit = list?.find((x) => x.id === id);
    return hit ? get(hit) : 'Unknown';
  };
  if (q.staffId) out.push({ label: 'Staff', value: name(o?.staff, q.staffId, (s) => s.name) });
  if (q.method) out.push({ label: 'Payment method', value: METHOD[q.method] ?? q.method });
  if (q.channel) out.push({ label: 'Service type', value: CHANNEL[q.channel] ?? q.channel });
  if (q.deviceId) out.push({ label: 'Terminal', value: name(o?.terminals, q.deviceId, (t) => t.name) });
  if (q.tableId) out.push({ label: 'Table', value: name(o?.tables, q.tableId, (t) => t.label) });
  if (q.categoryId) out.push({ label: 'Category', value: name(o?.categories, q.categoryId, (t) => t.name) });
  if (q.productId) out.push({ label: 'Item', value: name(o?.products, q.productId, (t) => t.name) });
  if (q.movementKind) out.push({ label: 'Movement', value: MOVEMENT[q.movementKind] ?? q.movementKind });
  if (q.orderStatus)
    out.push({
      label: 'Status',
      value: { completed: 'Completed', cancelled: 'Cancelled / voided', open: 'Open' }[q.orderStatus],
    });
  return out;
}

// ---------------------------------------------------------------------------
// The reports
// ---------------------------------------------------------------------------
async function buildReport(
  r: ReportRepository,
  kind: ReportKind,
  f: ReportFilter,
  q: ReportQuery,
  currency: string,
): Promise<Built> {
  switch (kind) {
    case 'end_of_day':
      return endOfDay(r, f);
    case 'tax':
      return tax(r, f);
    case 'items':
      return items(r, f, q.sort ?? 'sales');
    case 'payment_methods':
      return paymentMethods(r, f);
    case 'service_types':
      return serviceTypes(r, f);
    case 'terminals':
      return terminals(r, f);
    case 'sales_by_staff':
      return salesByStaff(r, f);
    case 'staff_activity':
      return staffActivity(r, f);
    case 'orders':
      return orders(r, f);
    case 'customers':
      return customers(r, f);
    case 'inventory_valuation':
      return valuation(r, f);
    case 'stock_movements':
    case 'deliveries':
    case 'wastage':
    case 'adjustments':
      return movements(r, f, kind);
    case 'stock_takes':
      return stockTakes(r, f);
    case 'recipe_consumption':
      return recipeConsumption(r, f, currency);
  }
}

const SALES_NOTE =
  'Sales are the items sent to the kitchen on orders opened in this period (restaurant business days), less cancelled and voided items. Net sales = gross − promotions − manager discounts. Money received = payments recorded − refunds.';

function salesMetrics(t: ReportRow): ReportMetric[] {
  const discounts = num(t.promo) + num(t.manual);
  const total = num(t.net) + num(t.exclusive_tax);
  return [
    m('Orders', num(t.orders), 'int'),
    m('Gross sales', num(t.gross)),
    m('Discounts and promotions', -discounts),
    m('Net sales', num(t.net), 'money', true),
    m('Tax', num(t.inclusive_tax) + num(t.exclusive_tax)),
    m('Total sales (incl. tax)', total),
    m('Average order', num(t.orders) ? Math.round(total / num(t.orders)) : 0),
  ];
}

const payCols = [
  col('method_label', 'Method'),
  col('payments', 'Payments', 'int'),
  col('gross', 'Received', 'money'),
  col('refunds', 'Refunds', 'money'),
  col('net', 'Net', 'money'),
  col('orders', 'Orders', 'int'),
  col('voided_count', 'Voided records', 'int'),
];
function payRows(rows: ReportRow[]): ReportRow[] {
  return (['cash', 'momo', 'card'] as const).map((method) => {
    const x = rows.find((r) => r.method === method) ?? {};
    return {
      method_label: METHOD[method]!,
      payments: num(x.payments),
      gross: num(x.gross),
      refunds: num(x.refunds),
      net: num(x.gross) - num(x.refunds),
      orders: num(x.orders),
      voided_count: num(x.voided_count),
    };
  });
}

async function endOfDay(r: ReportRepository, f: ReportFilter): Promise<Built> {
  const [t, pay, split, service, staff, term, taxes, voids, bills, regs, stock, top] = await Promise.all([
    r.salesTotals(f),
    r.paymentMethods(f),
    r.splitPayments(f),
    r.serviceTypes(f),
    r.staffSales(f),
    r.terminals(f),
    r.taxBreakdown(f),
    r.voids(f),
    r.bills(f),
    r.registers(f),
    r.movementSummary(f),
    r.items(f),
  ]);
  const p = payRows(pay);
  const received = p.reduce((n, x) => n + num(x.net), 0);
  const svc = service.map((s) => ext(s, { channel_label: CHANNEL[String(s.channel)] ?? s.channel }));
  const byChannel = (ch: string) => svc.find((s) => s.channel === ch) ?? {};
  return {
    summary: [
      { title: 'Sales', metrics: salesMetrics(t) },
      {
        title: 'Payments received',
        metrics: [
          ...p.map((x) => m(String(x.method_label), num(x.net))),
          m('Refunds', -p.reduce((n, x) => n + num(x.refunds), 0)),
          m('Net received', received, 'money', true),
          m('Orders paid in split payments', num(split.orders), 'int'),
        ],
      },
      {
        title: 'Service type',
        metrics: [
          m('Dine-in orders', num(byChannel('dine_in').orders), 'int'),
          m('Dine-in sales', num(byChannel('dine_in').total)),
          m('Takeaway orders', num(byChannel('takeaway').orders), 'int'),
          m('Takeaway sales', num(byChannel('takeaway').total)),
        ],
      },
      {
        title: 'Bills',
        metrics: [
          m('Bills issued', num(bills.issued), 'int'),
          m('Bills paid', num(bills.paid), 'int'),
          m('Bills outstanding', num(bills.outstanding), 'int'),
          m('Unpaid on open orders', num(bills.unpaid_amount)),
        ],
      },
      {
        title: 'Voids and cancellations',
        metrics: [
          m('Items voided', num(voids.voided_items), 'int'),
          m('Value of voided items', num(voids.voided_value)),
          m('Orders cancelled or voided', num(voids.cancelled_orders), 'int'),
        ],
      },
    ],
    tables: [
      table(
        'payments',
        'Payment methods',
        payCols,
        p,
        totals(p, 'method_label', ['payments', 'gross', 'refunds', 'net', 'orders', 'voided_count']),
      ),
      table(
        'service',
        'Service type',
        [
          col('channel_label', 'Service type'),
          col('orders', 'Orders', 'int'),
          col('net', 'Net sales', 'money'),
          col('tax', 'Tax', 'money'),
          col('total', 'Total', 'money'),
        ],
        svc,
        totals(svc, 'channel_label', ['orders', 'net', 'tax', 'total']),
      ),
      table(
        'staff',
        'Sales by staff',
        [
          col('staff', 'Staff'),
          col('role', 'Role'),
          col('orders', 'Orders taken', 'int'),
          col('sales', 'Sales (incl. tax)', 'money'),
          col('orders_sent', 'Sent to kitchen', 'int'),
          col('collected', 'Payments collected', 'money'),
        ],
        staff,
        totals(staff, 'staff', ['orders', 'sales', 'orders_sent', 'collected']),
      ),
      table(
        'terminals',
        'Sales by terminal',
        [
          col('terminal', 'Terminal'),
          col('orders', 'Orders', 'int'),
          col('cash', 'Cash', 'money'),
          col('momo', 'MoMo', 'money'),
          col('card', 'Card', 'money'),
          col('refunds', 'Refunds', 'money'),
          col('net', 'Net', 'money'),
        ],
        term,
        totals(term, 'terminal', ['orders', 'cash', 'momo', 'card', 'refunds', 'net']),
      ),
      taxTable(taxes),
      table(
        'registers',
        'Cash registers',
        [
          col('terminal_name', 'Terminal'),
          col('cashier_name', 'Cashier'),
          col('status_label', 'Status'),
          col('opening_cash', 'Opening', 'money'),
          col('cash_sales', 'Cash sales', 'money'),
          col('expected_cash', 'Expected', 'money'),
          col('counted_cash', 'Counted', 'money'),
          col('variance', 'Variance', 'money'),
        ],
        regs.map((x) => ext(x, { status_label: x.status === 'closed' ? 'Closed' : 'Open' })),
        null,
        'No register was opened in this period.',
      ),
      table(
        'stock',
        'Stock movements',
        [
          col('kind_label', 'Movement'),
          col('movements', 'Entries', 'int'),
          col('value', 'Value (at cost)', 'money'),
        ],
        stock.map((x) => ext(x, { kind_label: MOVEMENT[String(x.kind)] ?? x.kind })),
        null,
        'No stock movements in this period.',
      ),
      table(
        'top_items',
        'Best-selling items',
        [col('item', 'Item'), col('quantity', 'Qty', 'int'), col('net', 'Net sales', 'money')],
        top.slice(0, 15),
        null,
      ),
    ],
    notes: [SALES_NOTE],
  };
}

function taxTable(rows: ReportRow[]): ReportTable {
  const shaped = rows.map((x) =>
    ext(x, {
      treatment: x.is_inclusive === 'true' || x.is_inclusive === 't' ? 'Included in price' : 'Added to price',
    }),
  );
  return table(
    'tax_breakdown',
    'Tax breakdown',
    [
      col('name', 'Tax'),
      col('rate_bp', 'Rate', 'percent'),
      col('treatment', 'Treatment'),
      col('sales', 'Sales', 'money'),
      col('taxable', 'Taxable amount (excl. tax)', 'money'),
      col('tax', 'Tax', 'money'),
    ],
    shaped,
    totals(shaped, 'name', ['sales', 'taxable', 'tax']),
    'No taxed sales in this period.',
  );
}

async function tax(r: ReportRepository, f: ReportFilter): Promise<Built> {
  const [t, taxes, pay, voids] = await Promise.all([
    r.salesTotals(f),
    r.taxBreakdown(f),
    r.paymentMethods(f),
    r.voids(f),
  ]);
  const refunds = pay.reduce((n, x) => n + num(x.refunds), 0);
  const totalTax = num(t.inclusive_tax) + num(t.exclusive_tax);
  return {
    summary: [
      {
        title: 'Sales',
        metrics: [
          m('Gross sales', num(t.gross)),
          m('Promotions', -num(t.promo)),
          m('Manager discounts', -num(t.manual)),
          m('Net sales', num(t.net), 'money', true),
        ],
      },
      {
        title: 'Tax',
        metrics: [
          m('Taxable sales', num(t.taxed_lines_total)),
          m('Untaxed sales', num(t.untaxed)),
          m('Tax included in prices', num(t.inclusive_tax)),
          m('Tax added to prices', num(t.exclusive_tax)),
          m('Total tax', totalTax, 'money', true),
          m('Final taxable total (net of tax)', num(t.taxed_lines_total) - num(t.inclusive_tax)),
        ],
      },
      {
        title: 'Refunds and voids',
        metrics: [
          m('Refunds paid out', refunds),
          m('Voided items (not in sales)', num(voids.voided_value)),
          m('Orders cancelled or voided', num(voids.cancelled_orders), 'int'),
        ],
      },
    ],
    tables: [taxTable(taxes)],
    notes: [
      'Restaurant tax summary computed from the tax rates configured in MY FOOD (Menu → Taxes) and recorded on each order line at the time of sale. It is not an official tax return or filing.',
      '"Included in price": the tax is inside the menu price. "Added to price": the tax is charged on top. Taxable amount excludes the tax itself.',
      'Refunds are recorded as payments; they do not change the recorded sales or tax lines and are shown for information.',
      SALES_NOTE,
    ],
  };
}

async function items(
  r: ReportRepository,
  f: ReportFilter,
  sort: 'sales' | 'quantity' | 'name',
): Promise<Built> {
  const [rows, cats] = await Promise.all([r.items(f), r.categories(f)]);
  const shaped = rows
    .map((x) =>
      ext(x, {
        category: x.category ?? 'No category',
        average: num(x.quantity) ? Math.round(num(x.net) / num(x.quantity)) : 0,
      }),
    )
    .sort((a, b) =>
      sort === 'quantity'
        ? num(b.quantity) - num(a.quantity)
        : sort === 'name'
          ? String(a.item).localeCompare(String(b.item))
          : num(b.net) - num(a.net),
    );
  const qty = shaped.reduce((n, x) => n + num(x.quantity), 0);
  const net = shaped.reduce((n, x) => n + num(x.net), 0);
  return {
    summary: [
      {
        title: 'Items',
        metrics: [
          m('Items sold', qty, 'int'),
          m('Net sales', net, 'money', true),
          m('Discounts and promotions', -shaped.reduce((n, x) => n + num(x.promo) + num(x.manual), 0)),
          m('Different items', shaped.length, 'int'),
        ],
      },
    ],
    tables: [
      table(
        'items',
        'Item sales',
        [
          col('item', 'Item'),
          col('category', 'Category'),
          col('quantity', 'Qty', 'int'),
          col('gross', 'Gross', 'money'),
          col('promo', 'Promotions', 'money'),
          col('manual', 'Discounts', 'money'),
          col('net', 'Net sales', 'money'),
          col('average', 'Avg price', 'money'),
          col('tax', 'Tax', 'money'),
        ],
        shaped,
        totals(shaped, 'item', ['quantity', 'gross', 'promo', 'manual', 'net', 'tax']),
      ),
      table(
        'categories',
        'By category',
        [
          col('category', 'Category'),
          col('quantity', 'Qty', 'int'),
          col('gross', 'Gross', 'money'),
          col('discounts', 'Discounts', 'money'),
          col('net', 'Net sales', 'money'),
        ],
        cats,
        totals(cats, 'category', ['quantity', 'gross', 'discounts', 'net']),
      ),
    ],
    notes: [SALES_NOTE, 'Average price = net sales ÷ quantity.'],
  };
}

async function paymentMethods(r: ReportRepository, f: ReportFilter): Promise<Built> {
  const [pay, split] = await Promise.all([r.paymentMethods(f), r.splitPayments(f)]);
  const p = payRows(pay);
  const gross = p.reduce((n, x) => n + num(x.gross), 0);
  const refunds = p.reduce((n, x) => n + num(x.refunds), 0);
  return {
    summary: [
      {
        title: 'Payments',
        metrics: [
          m(
            'Payments',
            p.reduce((n, x) => n + num(x.payments), 0),
            'int',
          ),
          m('Received', gross),
          m('Refunds', -refunds),
          m('Net received', gross - refunds, 'money', true),
        ],
      },
      {
        title: 'Split payments',
        metrics: [
          m('Orders paid in parts', num(split.orders), 'int'),
          m('Payments on those orders', num(split.payments), 'int'),
          m('Amount (already in the methods above)', num(split.amount)),
        ],
      },
    ],
    tables: [
      table(
        'methods',
        'By payment method',
        payCols,
        p,
        totals(p, 'method_label', ['payments', 'gross', 'refunds', 'net', 'orders', 'voided_count']),
      ),
    ],
    notes: [
      'A split payment is one order paid with several payments (e.g. part cash, part MoMo). Each part is counted once, under its own method; the order is not counted twice.',
      'Voided payment records were entered by mistake and cancelled; they are not in any total.',
    ],
  };
}

async function serviceTypes(r: ReportRepository, f: ReportFilter): Promise<Built> {
  const rows = (await r.serviceTypes(f)).map((s) =>
    ext(s, {
      channel_label: CHANNEL[String(s.channel)] ?? s.channel,
      average: num(s.orders) ? Math.round(num(s.total) / num(s.orders)) : 0,
    }),
  );
  const total = totals(rows, 'channel_label', ['orders', 'gross', 'discounts', 'net', 'tax', 'total']);
  return {
    summary: [
      ...rows.map((s) => ({
        title: String(s.channel_label),
        metrics: [
          m('Orders', num(s.orders), 'int'),
          m('Sales', num(s.total), 'money', true),
          m('Average order', num(s.average)),
        ],
      })),
      {
        title: 'Total',
        metrics: [m('Orders', num(total?.orders), 'int'), m('Sales', num(total?.total), 'money', true)],
      },
    ],
    tables: [
      table(
        'service',
        'Sales by service type',
        [
          col('channel_label', 'Service type'),
          col('orders', 'Orders', 'int'),
          col('gross', 'Gross', 'money'),
          col('discounts', 'Discounts', 'money'),
          col('net', 'Net sales', 'money'),
          col('tax', 'Tax', 'money'),
          col('total', 'Total (incl. tax)', 'money'),
          col('average', 'Avg order', 'money'),
        ],
        rows,
        total,
      ),
    ],
    notes: ['The service type is the one stored on each order (dine-in or takeaway).', SALES_NOTE],
  };
}

async function terminals(r: ReportRepository, f: ReportFilter): Promise<Built> {
  const rows = await r.terminals(f);
  const t = totals(rows, 'terminal', [
    'orders',
    'payments',
    'cash',
    'momo',
    'card',
    'gross',
    'refunds',
    'net',
  ]);
  return {
    summary: [
      {
        title: 'Terminals',
        metrics: [
          m('Terminals used', rows.length, 'int'),
          m('Payments', num(t?.payments), 'int'),
          m('Net received', num(t?.net), 'money', true),
        ],
      },
    ],
    tables: [
      table(
        'terminals',
        'Sales by terminal',
        [
          col('terminal', 'Terminal'),
          col('orders', 'Orders', 'int'),
          col('payments', 'Payments', 'int'),
          col('cash', 'Cash', 'money'),
          col('momo', 'MoMo', 'money'),
          col('card', 'Card', 'money'),
          col('refunds', 'Refunds', 'money'),
          col('net', 'Net', 'money'),
        ],
        rows,
        t,
      ),
    ],
    notes: [
      'A terminal is the paired till (device) on which the payment was recorded. Payments taken by someone signed in on a computer that is not a paired till are listed as "No terminal".',
    ],
  };
}

async function salesByStaff(r: ReportRepository, f: ReportFilter): Promise<Built> {
  const rows = await r.staffSales(f);
  return {
    summary: [
      {
        title: 'Staff',
        metrics: [
          m('Staff with activity', rows.length, 'int'),
          m(
            'Sales on their orders',
            rows.reduce((n, x) => n + num(x.sales), 0),
            'money',
            true,
          ),
          m(
            'Payments collected',
            rows.reduce((n, x) => n + num(x.collected), 0),
          ),
        ],
      },
    ],
    tables: [
      table(
        'staff',
        'Sales by staff',
        [
          col('staff', 'Staff'),
          col('role', 'Role'),
          col('orders', 'Orders taken', 'int'),
          col('items', 'Items', 'int'),
          col('sales', 'Sales (incl. tax)', 'money'),
          col('discounts', 'Discounts on their orders', 'money'),
          col('orders_sent', 'Orders sent to kitchen', 'int'),
          col('payments', 'Payments taken', 'int'),
          col('collected', 'Amount collected', 'money'),
          col('cash', 'Cash collected', 'money'),
          col('refunds', 'Refunds', 'money'),
        ],
        rows,
        totals(rows, 'staff', [
          'orders',
          'items',
          'sales',
          'discounts',
          'orders_sent',
          'payments',
          'collected',
          'cash',
          'refunds',
        ]),
      ),
    ],
    notes: [
      'Each identity is kept separately: "Orders taken" and "Sales" belong to the person who opened the order; "Orders sent to kitchen" to whoever sent it; "Payments" to the cashier who recorded them. When Kofi takes and sends an order and Ama takes the payment, the sale is Kofi’s and the payment is Ama’s.',
      'Listed by name. This is an operational record, not a ranking.',
    ],
  };
}

async function staffActivity(r: ReportRepository, f: ReportFilter): Promise<Built> {
  const rows = await r.staffActivity(f);
  return {
    summary: [
      {
        title: 'Activity',
        metrics: [
          m('Staff with activity', rows.length, 'int'),
          m(
            'Orders created',
            rows.reduce((n, x) => n + num(x.orders_created), 0),
            'int',
          ),
          m(
            'Payments',
            rows.reduce((n, x) => n + num(x.payments), 0),
            'int',
          ),
        ],
      },
    ],
    tables: [
      table(
        'activity',
        'Activity by staff member',
        [
          col('staff', 'Staff'),
          col('role', 'Role'),
          col('orders_created', 'Orders created', 'int'),
          col('orders_sent', 'Sent to kitchen', 'int'),
          col('payments', 'Payments', 'int'),
          col('collected', 'Collected', 'money'),
          col('refunds', 'Refunds', 'int'),
          col('bills', 'Bills printed', 'int'),
          col('voids', 'Item voids', 'int'),
          col('cancellations', 'Order cancellations', 'int'),
          col('payment_voids', 'Payment voids', 'int'),
          col('discounts', 'Discounts given', 'int'),
          col('discount_amount', 'Discount amount', 'money'),
          col('registers_opened', 'Registers opened', 'int'),
          col('registers_closed', 'Registers closed', 'int'),
        ],
        rows,
        totals(rows, 'staff', [
          'orders_created',
          'orders_sent',
          'payments',
          'collected',
          'refunds',
          'bills',
          'voids',
          'cancellations',
          'payment_voids',
          'discounts',
          'discount_amount',
          'registers_opened',
          'registers_closed',
        ]),
      ),
    ],
    notes: [
      'Orders, kitchen sends and payments are counted on orders opened in the period; bills, voids and cancellations by when they happened (restaurant business days).',
      'Listed by name. This is an operational record, not a ranking.',
    ],
  };
}

async function orders(r: ReportRepository, f: ReportFilter): Promise<Built> {
  const LIMIT = 5000;
  const rows = (await r.orders(f, LIMIT)).map((o) =>
    ext(o, {
      channel_label: CHANNEL[String(o.channel)] ?? o.channel,
      status_label: STATUS[String(o.status)] ?? o.status,
      payment_label: PAY_STATUS[String(o.payment_status)] ?? o.payment_status,
      methods: o.methods
        ? String(o.methods)
            .split(', ')
            .map((x) => METHOD[x] ?? x)
            .join(', ')
        : null,
    }),
  );
  const done = rows.filter((o) => o.status !== 'cancelled' && o.status !== 'voided');
  return {
    summary: [
      {
        title: 'Orders',
        metrics: [
          m('Orders', rows.length, 'int'),
          m('Completed', rows.filter((o) => o.status === 'completed').length, 'int'),
          m('Cancelled or voided', rows.length - done.length, 'int'),
          m(
            'Total (not cancelled)',
            done.reduce((n, o) => n + num(o.total), 0),
            'money',
            true,
          ),
          m(
            'Paid',
            done.reduce((n, o) => n + num(o.paid), 0),
          ),
        ],
      },
    ],
    tables: [
      table(
        'orders',
        'Orders',
        [
          col('order_number', 'No.', 'int'),
          col('business_day_text', 'Day', 'date'),
          col('created_at', 'Opened', 'datetime'),
          col('channel_label', 'Type'),
          col('table_label', 'Table'),
          col('customer_name', 'Customer'),
          col('order_staff', 'Order staff'),
          col('sent_by', 'Sent by'),
          col('cashier', 'Cashier'),
          col('status_label', 'Status'),
          col('payment_label', 'Payment'),
          col('methods', 'Methods'),
          col('discounts', 'Discounts', 'money'),
          col('total', 'Total', 'money'),
          col('paid', 'Paid', 'money'),
        ],
        rows,
        totals(done, 'order_number', ['discounts', 'total', 'paid']),
      ),
    ],
    notes: [
      rows.length >= LIMIT
        ? `Only the latest ${LIMIT} orders are listed; choose a shorter period for the rest.`
        : '',
      'Totals exclude cancelled and voided orders.',
    ].filter(Boolean),
  };
}

async function customers(r: ReportRepository, f: ReportFilter): Promise<Built> {
  const { totals: t, rows } = await r.customers(f);
  return {
    summary: [
      {
        title: 'Customers',
        metrics: [
          m('Customers on record', num(t.customers), 'int'),
          m('New customers', num(t.new_customers), 'int'),
          m('Customers who ordered', num(t.visiting), 'int', true),
          m('Returning customers', num(t.returning), 'int'),
          m('Their orders', num(t.orders), 'int'),
          m('Their spend', num(t.spend)),
        ],
      },
    ],
    tables: [
      table(
        'customers',
        'Customers who ordered in this period',
        [
          col('name', 'Customer'),
          col('phone', 'Telephone'),
          col('orders', 'Orders', 'int'),
          col('spend', 'Spend', 'money'),
          col('first_visit_text', 'First visit', 'date'),
          col('last_visit_text', 'Last visit', 'date'),
          col('lifetime_orders', 'All-time orders', 'int'),
        ],
        rows,
        totals(rows, 'name', ['orders', 'spend']),
        'No orders were linked to a customer in this period.',
      ),
    ],
    notes: [
      'Only orders taken with the customer’s telephone number are linked to a customer. Returning = ordered in this period and also before it.',
      'Contains private customer information. Keep exports safe and do not share them outside the restaurant.',
    ],
  };
}

async function valuation(r: ReportRepository, f: ReportFilter): Promise<Built> {
  const rows = await r.inventoryValuation(f.branchId);
  const value = rows.reduce((n, x) => n + num(x.value), 0);
  return {
    summary: [
      {
        title: 'Stock',
        metrics: [
          m('Items', rows.length, 'int'),
          m('Stock value (at cost)', value, 'money', true),
          m('Low stock', rows.filter((x) => x.stock_status === 'Low').length, 'int'),
          m('Out of stock', rows.filter((x) => x.stock_status === 'Out of stock').length, 'int'),
        ],
      },
    ],
    tables: [
      table(
        'valuation',
        'Inventory valuation',
        [
          col('item', 'Item'),
          col('category', 'Category'),
          col('unit', 'Unit'),
          col('quantity', 'Quantity', 'qty'),
          col('min_quantity', 'Minimum', 'qty'),
          col('unit_cost', 'Unit cost', 'money'),
          col('value', 'Value', 'money'),
          col('stock_status', 'Status'),
        ],
        rows,
        totals(rows, 'item', ['value']),
        'No inventory items yet.',
      ),
    ],
    notes: [
      'Quantities are the stock on hand now, kept by the stock ledger (every delivery, sale, wastage, adjustment and approved stock take). The date filters do not apply to this report.',
    ],
  };
}

async function movements(
  r: ReportRepository,
  f: ReportFilter,
  kind: 'stock_movements' | 'deliveries' | 'wastage' | 'adjustments',
): Promise<Built> {
  const kinds =
    kind === 'deliveries'
      ? ['receive']
      : kind === 'wastage'
        ? ['waste']
        : kind === 'adjustments'
          ? ['adjust', 'count']
          : null;
  const LIMIT = 5000;
  const rows = (await r.movements(f, kinds, LIMIT)).map((x) =>
    ext(x, {
      kind_label: MOVEMENT[String(x.kind)] ?? x.kind,
      quantity: Math.abs(num(x.quantity_delta)),
    }),
  );
  const value = rows.reduce((n, x) => n + num(x.value), 0);
  const columns: Record<typeof kind, ReportColumn[]> = {
    stock_movements: [
      col('created_at', 'Date / time', 'datetime'),
      col('item', 'Item'),
      col('kind_label', 'Movement'),
      col('quantity_delta', 'Change', 'qty'),
      col('quantity_before', 'Before', 'qty'),
      col('quantity_after', 'After', 'qty'),
      col('unit', 'Unit'),
      col('value', 'Value', 'money'),
      col('reason', 'Reason'),
      col('reference', 'Reference'),
      col('staff', 'Staff'),
      col('order_number', 'Order', 'int'),
    ],
    deliveries: [
      col('created_at', 'Date / time', 'datetime'),
      col('item', 'Item'),
      col('quantity', 'Quantity', 'qty'),
      col('unit', 'Unit'),
      col('unit_cost', 'Unit cost', 'money'),
      col('value', 'Total cost', 'money'),
      col('reference', 'Supplier / invoice'),
      col('reason', 'Note'),
      col('staff', 'Received by'),
    ],
    wastage: [
      col('created_at', 'Date / time', 'datetime'),
      col('item', 'Item'),
      col('quantity', 'Quantity', 'qty'),
      col('unit', 'Unit'),
      col('value', 'Value', 'money'),
      col('reason', 'Reason'),
      col('staff', 'Recorded by'),
    ],
    adjustments: [
      col('created_at', 'Date / time', 'datetime'),
      col('item', 'Item'),
      col('kind_label', 'Type'),
      col('quantity_delta', 'Adjustment', 'qty'),
      col('quantity_before', 'Before', 'qty'),
      col('quantity_after', 'After', 'qty'),
      col('unit', 'Unit'),
      col('reason', 'Reason'),
      col('staff', 'Staff'),
      col('approval', 'Approval'),
    ],
  };
  const label = {
    stock_movements: 'Movements',
    deliveries: 'Deliveries',
    wastage: 'Wastage entries',
    adjustments: 'Adjustments',
  }[kind];
  return {
    summary: [
      {
        title: REPORT_TITLES[kind],
        metrics: [
          m(label, rows.length, 'int'),
          ...(kind === 'adjustments' || kind === 'stock_movements'
            ? []
            : [m(kind === 'deliveries' ? 'Total cost' : 'Value', value, 'money', true)]),
        ],
      },
    ],
    tables: [
      table(
        kind,
        REPORT_TITLES[kind],
        columns[kind],
        rows,
        kind === 'deliveries' || kind === 'wastage' ? totals(rows, 'created_at', ['value']) : null,
      ),
    ],
    notes: [
      'From the stock ledger: every change of stock is recorded once, with who made it, and is never edited.',
      kind === 'adjustments'
        ? 'Adjustments are recorded directly by someone with inventory management rights; stock-take corrections are applied only when the stock take is approved.'
        : '',
      rows.length >= LIMIT
        ? `Only the latest ${LIMIT} entries are listed; choose a shorter period for the rest.`
        : '',
      'Values are at the unit cost recorded with the movement (or the item’s current cost when none was recorded).',
    ].filter(Boolean),
  };
}

async function stockTakes(r: ReportRepository, f: ReportFilter): Promise<Built> {
  const rows = (await r.stockTakes(f)).map((x) =>
    ext(x, { status_label: x.status === 'approved' ? 'Approved' : 'Submitted' }),
  );
  return {
    summary: [
      {
        title: 'Stock taking',
        metrics: [
          m('Lines counted', rows.length, 'int'),
          m('Lines with a variance', rows.filter((x) => num(x.variance) !== 0).length, 'int'),
          m(
            'Variance value',
            rows.reduce((n, x) => n + num(x.variance_value), 0),
            'money',
            true,
          ),
        ],
      },
    ],
    tables: [
      table(
        'stock_takes',
        'Stock taking',
        [
          col('counted_at', 'Date', 'datetime'),
          col('status_label', 'Status'),
          col('item', 'Item'),
          col('unit', 'Unit'),
          col('expected', 'Expected', 'qty'),
          col('counted', 'Counted', 'qty'),
          col('variance', 'Variance', 'qty'),
          col('variance_value', 'Variance value', 'money'),
          col('reason', 'Reason'),
          col('counted_by', 'Counted by'),
          col('submitted_by', 'Submitted by'),
          col('approved_by', 'Approved by'),
        ],
        rows,
        totals(rows, 'counted_at', ['variance_value']),
        'No stock takes were submitted or approved in this period.',
      ),
    ],
    notes: ['Variance = counted − expected. Stock changes only when a stock take is approved.'],
  };
}

async function recipeConsumption(r: ReportRepository, f: ReportFilter, _currency: string): Promise<Built> {
  const rows = await r.recipeConsumption(f);
  return {
    summary: [
      {
        title: 'Consumption',
        metrics: [
          m('Ingredients used', rows.length, 'int'),
          m(
            'Cost of ingredients',
            rows.reduce((n, x) => n + num(x.cost), 0),
            'money',
            true,
          ),
        ],
      },
    ],
    tables: [
      table(
        'consumption',
        'Ingredients used by sales',
        [
          col('item', 'Ingredient'),
          col('unit', 'Unit'),
          col('used', 'Used', 'qty'),
          col('cost', 'Cost', 'money'),
          col('orders', 'Orders', 'int'),
        ],
        rows,
        totals(rows, 'item', ['cost']),
        'No recipe stock was used in this period (only products with a recipe deduct stock).',
      ),
    ],
    notes: [
      'Stock taken by sales of products that have a recipe, less stock returned when items were voided.',
    ],
  };
}

function registerClosing(r: RegisterSessionView, extra: ReportRow, timeZone: string): Built {
  const at = (iso: string | null) => (iso ? localStamp(new Date(iso), timeZone) : '—');
  const method = (k: 'cash' | 'momo' | 'card') => r.byMethod.find((x) => x.method === k);
  return {
    summary: [
      {
        title: 'Register',
        metrics: [
          m('Cashier', r.cashierName, 'text'),
          m('Terminal', r.terminalName, 'text'),
          m('Session', r.id.slice(0, 8).toUpperCase(), 'text'),
          m('Opened', at(r.openedAt), 'text'),
          m('Closed', r.closedAt ? at(r.closedAt) : 'Still open', 'text'),
          m('Status', r.status === 'closed' ? 'Closed' : 'Open', 'text'),
        ],
      },
      {
        title: 'Cash',
        metrics: [
          m('Opening cash', r.openingCash),
          m('Cash sales', r.cashSales),
          m('Cash refunds', -r.cashRefunds),
          m('Expected cash', r.expectedCash, 'money', true),
          m('Actual cash (counted)', r.countedCash),
          m('Variance', r.variance),
        ],
      },
      {
        title: 'Other payments',
        metrics: [
          m('MoMo', method('momo')?.net ?? 0),
          m('Card', method('card')?.net ?? 0),
          m('Total sales (all methods)', r.totalNet, 'money', true),
        ],
      },
      {
        title: 'Orders',
        metrics: [
          m('Orders', r.orders.total, 'int'),
          m('Dine-in', r.orders.dineIn, 'int'),
          m('Takeaway', r.orders.takeaway, 'int'),
          m('Discounts', -num(extra.discounts)),
          m('Tax', num(extra.tax)),
          m('Voided items', num(extra.voided_items), 'int'),
        ],
      },
    ],
    tables: [
      table(
        'methods',
        'Payments by method',
        [
          col('label', 'Method'),
          col('count', 'Payments', 'int'),
          col('charges', 'Received', 'money'),
          col('refunds', 'Refunds', 'money'),
          col('net', 'Net', 'money'),
        ],
        r.byMethod.map((x) => ({
          label: METHOD[x.method]!,
          count: x.count,
          charges: x.charges,
          refunds: x.refunds,
          net: x.net,
        })),
        totals(
          r.byMethod.map((x) => ({ count: x.count, charges: x.charges, refunds: x.refunds, net: x.net })),
          'label',
          ['count', 'charges', 'refunds', 'net'],
        ),
      ),
    ],
    notes: [
      'Expected cash = opening cash + cash payments − cash refunds taken on this register. Variance = actual − expected (negative: cash short; positive: cash over). Figures are as recorded when the register was closed; nothing is adjusted to match the count.',
      r.reopenCount > 0
        ? `This register was reopened ${r.reopenCount} time(s) by a manager. Reason: ${r.reopenReason ?? '—'}.`
        : '',
      r.closingNote ? `Cashier note: ${r.closingNote}` : '',
    ].filter(Boolean),
    signOff: ['Cashier signature', 'Manager signature'],
  };
}
