import { localTime } from './business-day';
import type { OrderChannel } from './enums';
import { formatMinor } from './money';

/**
 * Printer-agnostic document model. The print agent renders it for the actual
 * device (ESC/POS today, something else tomorrow). The order domain never
 * knows printer bytes.
 */
export type DocumentBlock =
  | {
      type: 'text';
      text: string;
      align?: 'left' | 'center' | 'right';
      size?: 'normal' | 'tall' | 'large';
      bold?: boolean;
    }
  | { type: 'columns'; left: string; right: string; bold?: boolean }
  | { type: 'divider' }
  /** The restaurant logo: raster on thermal printers, the image in browser print. */
  | { type: 'logo' }
  | { type: 'feed'; lines: number }
  | { type: 'cut' };

export interface PrintDocument {
  schema: 1;
  title: string;
  blocks: DocumentBlock[];
}

export interface KitchenTicketInput {
  stationName: string;
  orderNumber: number;
  channel: OrderChannel;
  areaName: string;
  tableLabel: string | null;
  customerName: string | null;
  orderNotes: string | null;
  createdAt: Date;
  timeZone: string;
  submissionSeq: number;
  ticketId: string;
  items: { quantity: number; name: string; modifiers: string[]; notes: string | null }[];
}

export function kitchenTicketDocument(t: KitchenTicketInput): PrintDocument {
  const where =
    t.channel === 'dine_in'
      ? `${t.areaName.toUpperCase()}${t.tableLabel ? ` - TABLE ${t.tableLabel}` : ''}`
      : `TAKEAWAY${t.customerName ? ` - ${t.customerName.toUpperCase()}` : ''}`;
  const blocks: DocumentBlock[] = [
    { type: 'text', text: t.stationName.toUpperCase(), align: 'center', bold: true },
    { type: 'text', text: `ORDER #${t.orderNumber}`, align: 'center', size: 'large', bold: true },
    { type: 'text', text: where, align: 'center', size: 'tall', bold: true },
    {
      type: 'columns',
      left: localTime(t.createdAt, t.timeZone),
      right: t.submissionSeq > 1 ? `ROUND ${t.submissionSeq}` : '',
    },
    { type: 'divider' },
  ];
  for (const item of t.items) {
    blocks.push({
      type: 'text',
      text: `${item.quantity} x ${item.name.toUpperCase()}`,
      size: 'tall',
      bold: true,
    });
    for (const m of item.modifiers) blocks.push({ type: 'text', text: `   + ${m}` });
    if (item.notes) blocks.push({ type: 'text', text: `   ! ${item.notes}`, bold: true });
  }
  if (t.orderNotes) {
    blocks.push({ type: 'divider' }, { type: 'text', text: `NOTE: ${t.orderNotes}`, bold: true });
  }
  blocks.push(
    { type: 'divider' },
    { type: 'text', text: `ticket ${t.ticketId.slice(0, 8)}`, align: 'right' },
    { type: 'feed', lines: 3 },
    { type: 'cut' },
  );
  return { schema: 1, title: `${t.stationName} #${t.orderNumber}`, blocks };
}

// ---------------------------------------------------------------------------
// Customer receipt
// ---------------------------------------------------------------------------
export interface ReceiptInput {
  restaurantName: string;
  restaurantPhone?: string | null;
  branchName: string;
  branchAddress: string | null;
  currency: string;
  orderNumber: number;
  channel: OrderChannel;
  tableLabel: string | null;
  customerName: string | null;
  issuedAt: Date;
  timeZone: string;
  cashierName: string | null;
  items: {
    quantity: number;
    name: string;
    unitPrice?: number;
    lineTotal: number;
    modifiers: { name: string; priceDelta: number }[];
    voided: boolean;
  }[];
  subtotal: number;
  discountTotal: number;
  taxes: { name: string; rateBp: number; isInclusive: boolean; amount: number }[];
  grandTotal: number;
  payments: {
    method: string;
    amount: number;
    tendered: number | null;
    change: number;
    direction: 'charge' | 'refund';
  }[];
  balanceDue: number;
  footer: string | null;
}

const METHOD_LABEL: Record<string, string> = { cash: 'CASH', momo: 'MOBILE MONEY', card: 'CARD' };

export function receiptDocument(r: ReceiptInput): PrintDocument {
  const money = (minor: number) => formatMinor(minor, r.currency);
  const localDate = new Intl.DateTimeFormat('en-GB', {
    timeZone: r.timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(r.issuedAt);
  const blocks: DocumentBlock[] = [
    { type: 'logo' },
    { type: 'text', text: r.restaurantName.toUpperCase(), align: 'center', size: 'tall', bold: true },
  ];
  if (r.branchAddress) blocks.push({ type: 'text', text: r.branchAddress, align: 'center' });
  if (r.restaurantPhone) blocks.push({ type: 'text', text: `Tel: ${r.restaurantPhone}`, align: 'center' });
  blocks.push(
    { type: 'divider' },
    {
      type: 'columns',
      left: `ORDER #${r.orderNumber}`,
      right: `${localDate} ${localTime(r.issuedAt, r.timeZone)}`,
      bold: true,
    },
    {
      type: 'text',
      text:
        r.channel === 'dine_in'
          ? `DINE IN${r.tableLabel ? ` - TABLE ${r.tableLabel}` : ''}`
          : `TAKEAWAY${r.customerName ? ` - ${r.customerName}` : ''}`,
    },
  );
  if (r.cashierName) blocks.push({ type: 'text', text: `Served by: ${r.cashierName}` });
  blocks.push({ type: 'divider' });

  for (const item of r.items.filter((i) => !i.voided)) {
    blocks.push({ type: 'columns', left: `${item.quantity} x ${item.name}`, right: money(item.lineTotal) });
    if (item.quantity > 1 && item.unitPrice !== undefined)
      blocks.push({ type: 'text', text: `   @ ${money(item.unitPrice)} each` });
    for (const m of item.modifiers) {
      blocks.push({ type: 'text', text: `   + ${m.name}${m.priceDelta ? ` (${money(m.priceDelta)})` : ''}` });
    }
  }
  blocks.push({ type: 'divider' }, { type: 'columns', left: 'Subtotal', right: money(r.subtotal) });
  if (r.discountTotal > 0)
    blocks.push({ type: 'columns', left: 'Discount', right: `-${money(r.discountTotal)}` });
  for (const t of r.taxes) {
    const label = `${t.isInclusive ? 'incl. ' : ''}${t.name} ${(t.rateBp / 100).toFixed(2).replace(/\.00$/, '')}%`;
    blocks.push({ type: 'columns', left: label, right: money(t.amount) });
  }
  blocks.push(
    { type: 'columns', left: 'TOTAL', right: money(r.grandTotal), bold: true },
    { type: 'divider' },
  );

  for (const p of r.payments) {
    const label = `${p.direction === 'refund' ? 'REFUND ' : ''}${METHOD_LABEL[p.method] ?? p.method.toUpperCase()}`;
    blocks.push({
      type: 'columns',
      left: label,
      right: `${p.direction === 'refund' ? '-' : ''}${money(p.amount)}`,
    });
    if (p.tendered !== null && p.tendered !== p.amount) {
      blocks.push({ type: 'columns', left: '  Cash received', right: money(p.tendered) });
      blocks.push({ type: 'columns', left: '  Change', right: money(p.change) });
    }
  }
  if (r.payments.length === 0) blocks.push({ type: 'text', text: 'NOT PAID', bold: true });
  if (r.balanceDue > 0)
    blocks.push({ type: 'columns', left: 'BALANCE DUE', right: money(r.balanceDue), bold: true });
  blocks.push({ type: 'feed', lines: 1 }, { type: 'text', text: r.footer ?? 'Thank you!', align: 'center' });
  blocks.push({ type: 'feed', lines: 3 }, { type: 'cut' });
  return { schema: 1, title: `Receipt #${r.orderNumber}`, blocks };
}

// ---------------------------------------------------------------------------
// Void slip: tells a station to stop making something
// ---------------------------------------------------------------------------
export function voidSlipDocument(v: {
  stationName: string;
  orderNumber: number;
  tableLabel: string | null;
  reason: string;
  createdAt: Date;
  timeZone: string;
  items: { quantity: number; name: string }[];
  wholeOrder: boolean;
}): PrintDocument {
  const blocks: DocumentBlock[] = [
    {
      type: 'text',
      text: v.wholeOrder ? '*** ORDER CANCELLED ***' : '*** VOID ***',
      align: 'center',
      size: 'large',
      bold: true,
    },
    { type: 'text', text: v.stationName.toUpperCase(), align: 'center', bold: true },
    {
      type: 'text',
      text: `ORDER #${v.orderNumber}${v.tableLabel ? ` - TABLE ${v.tableLabel}` : ''}`,
      align: 'center',
      size: 'tall',
      bold: true,
    },
    { type: 'columns', left: localTime(v.createdAt, v.timeZone), right: '' },
    { type: 'divider' },
  ];
  for (const i of v.items)
    blocks.push({ type: 'text', text: `DO NOT MAKE: ${i.quantity} x ${i.name.toUpperCase()}`, bold: true });
  blocks.push({ type: 'text', text: `Reason: ${v.reason}` }, { type: 'feed', lines: 3 }, { type: 'cut' });
  return { schema: 1, title: `Void #${v.orderNumber}`, blocks };
}
