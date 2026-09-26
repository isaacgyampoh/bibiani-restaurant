import type { ActivityEntryView, ActivityView, MeView } from '@rp/contracts';
import { formatMinor } from '@rp/domain';
import { useEffect, useState } from 'react';
import { api } from '../../infra/session';
import { ErrorBox } from '../../ui/components';
import { Empty, Shell, Skeleton } from '../../ui/Shell';

const FILTERS = [
  ['', 'Everything'],
  ['menu', 'Menu & prices'],
  ['promotions', 'Promotions'],
  ['payments', 'Payments & discounts'],
  ['orders', 'Orders'],
  ['inventory', 'Stock'],
  ['staff', 'Staff & PINs'],
  ['setup', 'Setup'],
] as const;

type Rec = Record<string, unknown> | null;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

const THING: Record<string, string> = {
  product: 'product',
  category: 'category',
  modifierGroup: 'option group',
  modifier: 'option',
  taxRate: 'tax',
  restaurant: 'restaurant details',
  branch: 'branch',
  area: 'area',
  table: 'table',
  station: 'kitchen station',
  stationOutput: 'station screen/printer',
  routingRule: 'routing rule',
  device: 'device',
  role: 'role',
};

/** What happened, in words a manager uses. `money` formats minor units in the restaurant currency. */
export function describeActivity(
  e: ActivityEntryView,
  money: (m: number) => string,
): { what: string; detail: string } {
  const a = e.action;
  const before = e.before as Rec;
  const after = e.after as Rec;
  const [head, entity, verb] = a.split('.');
  if (head === 'config' && entity && verb) {
    if (entity === 'branchProduct')
      return { what: after?.isAvailable === false ? 'Marked sold out' : 'Put back on sale', detail: '' };
    const thing = THING[entity] ?? entity;
    if (verb === 'delete') return { what: `Removed ${thing}`, detail: '' };
    if (verb === 'create')
      return {
        what: `Added ${thing}`,
        detail:
          entity === 'product' && after?.basePrice !== undefined
            ? `Price ${money(num(after.basePrice))}`
            : '',
      };
    return {
      what: `Changed ${thing}`,
      detail: entity === 'product' ? productChanges(before, after, money) : '',
    };
  }
  const simple: Record<string, string> = {
    'menu.recipe_update': 'Changed recipe',
    'product.image': before?.imagePath ? 'Replaced photo' : 'Added photo',
    'product.image_removed': 'Removed photo',
    'promotion.create': 'Created promotion',
    'promotion.update': 'Changed promotion',
    'promotion.activate': 'Turned promotion on',
    'promotion.pause': 'Paused promotion',
    'promotion.end': 'Ended promotion',
    'order.cancel': 'Cancelled order',
    'order.void_items': 'Voided items',
    'order.transfer': 'Moved order',
    'order.merge': 'Merged orders',
    'order.priority': after?.rush ? 'Marked as rush' : 'Rush removed',
    'order.discount': 'Manager discount',
    'order.discount_removed': 'Removed manager discount',
    'payment.record': 'Payment taken',
    'payment.void': 'Voided payment',
    'payment.refund': 'Refund',
    'receipt.reprint': 'Reprinted receipt',
    'inventory.item_create': 'Added stock item',
    'inventory.item_update': 'Changed stock item',
    'inventory.receive': 'Delivery received',
    'inventory.waste': 'Wastage recorded',
    'inventory.adjust': 'Stock adjusted',
    'stock_count.start': 'Stock count started',
    'stock_count.submit': 'Stock count submitted',
    'stock_count.approve': 'Stock count approved',
    'stock_count.cancel': 'Stock count cancelled',
    'staff.create': 'Added staff member',
    'staff.update': after?.isActive === false ? 'Deactivated staff member' : 'Changed staff member',
    'staff.pin_assigned': 'Assigned a starting PIN',
    'staff.pin_reset': 'Reset PIN',
    'staff.pin_activated': 'Chose their own PIN',
    'staff.pin_changed': 'Changed their PIN',
    'staff.pin_recovery_requested': 'Asked to recover their PIN',
    'staff.pin_sign_in': 'Signed in with PIN',
    'security.pin_lockout': 'Till locked after wrong PINs',
    'device.paired': 'Device set up',
    'device.pairing_code_created': 'Pairing code created',
    'device.revoked': 'Device removed',
    'print_job.retry': 'Print retried',
  };
  const what = simple[a] ?? a.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());
  let detail = '';
  if (a === 'order.discount' && after) detail = `${money(num(after.amount))}`;
  else if ((a === 'payment.record' || a === 'payment.refund') && after?.amount !== undefined)
    detail = `${money(num(after.amount))}${after.method ? ` · ${String(after.method)}` : ''}`;
  else if (a.startsWith('inventory.') && after?.quantity !== undefined && a !== 'inventory.item_update')
    detail = `${num(after.quantity) > 0 && a !== 'inventory.waste' ? '+' : ''}${after.quantity} (now ${after.after ?? '?'})`;
  else if (a === 'order.cancel' && after?.stockItemsReturned)
    detail = `${after.stockItemsReturned} stock item(s) returned`;
  return { what, detail };
}

function productChanges(before: Rec, after: Rec, money: (m: number) => string): string {
  if (!before || !after) return '';
  const changes: string[] = [];
  if (after.basePrice !== undefined && num(before.base_price) !== num(after.basePrice))
    changes.push(`Price ${money(num(before.base_price))} to ${money(num(after.basePrice))}`);
  if (after.name !== undefined && before.name !== after.name)
    changes.push(`Name “${before.name}” to “${after.name}”`);
  if (after.isActive !== undefined && Boolean(before.is_active) !== Boolean(after.isActive))
    changes.push(after.isActive ? 'Back on the menu' : 'Hidden from the menu');
  if (after.categoryId !== undefined && before.category_id !== after.categoryId)
    changes.push('Category changed');
  if (after.description !== undefined && (before.description ?? null) !== (after.description ?? null))
    changes.push('Description changed');
  if (after.kitchenName !== undefined && (before.kitchen_name ?? null) !== (after.kitchenName ?? null))
    changes.push('Kitchen name changed');
  return changes.join(' · ');
}

/** Who changed what, and when. Read-only: the history can never be edited or deleted. */
export function ActivityPage({ me }: { me: MeView }) {
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ActivityView | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const money = (m: number) => formatMinor(m, me.restaurant.currency);

  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    setView(null);
    setError(null);
    api
      .activity({ category: category || null, q: search || null })
      .then(setView)
      .catch(setError);
  }, [category, search]);

  const [exporting, setExporting] = useState(false);
  /** Everything matching the current filter and search (up to 1,200 entries) as a spreadsheet file. */
  async function exportCsv() {
    setExporting(true);
    setError(null);
    try {
      const rows: ActivityEntryView[] = [];
      let before: number | null = null;
      for (let page = 0; page < 20; page++) {
        const next = await api.activity({ category: category || null, q: search || null, before });
        rows.push(...next.entries);
        if (!next.nextBefore) break;
        before = next.nextBefore;
      }
      const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const lines = [
        ['When', 'Who', 'Device', 'What', 'Item', 'Details', 'Reason'].map(cell).join(','),
        ...rows.map((e) => {
          const d = describeActivity(e, money);
          return [
            new Date(e.at).toISOString(),
            e.actor ?? '',
            e.device ?? '',
            d.what,
            e.entityLabel ?? '',
            d.detail,
            e.reason ?? '',
          ]
            .map((v) => cell(String(v)))
            .join(',');
        }),
      ];
      const url = URL.createObjectURL(new Blob([`\ufeff${lines.join('\r\n')}`], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `activity-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e);
    } finally {
      setExporting(false);
    }
  }

  async function loadMore() {
    if (!view?.nextBefore) return;
    setMore(true);
    try {
      const next = await api.activity({
        category: category || null,
        q: search || null,
        before: view.nextBefore,
      });
      setView({ entries: [...view.entries, ...next.entries], nextBefore: next.nextBefore });
    } catch (e) {
      setError(e);
    } finally {
      setMore(false);
    }
  }

  return (
    <Shell
      me={me}
      title="Activity"
      subtitle="Who changed what, and when: prices, promotions, discounts, stock, staff and PINs. Kept permanently; it cannot be edited."
      actions={
        <button type="button" className="btn" disabled={exporting} onClick={() => void exportCsv()}>
          {exporting ? 'Preparing file…' : 'Export CSV'}
        </button>
      }
    >
      <ErrorBox error={error} />
      <section className="card">
        <div className="toolbar wrap">
          <div className="seg">
            {FILTERS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={category === k}
                className={category === k ? 'on' : ''}
                onClick={() => setCategory(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            className="search"
            placeholder="Search a product, person, order or reason"
            aria-label="Search activity"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {!view ? (
          <Skeleton rows={8} />
        ) : view.entries.length === 0 ? (
          <Empty title={search || category ? 'Nothing matches' : 'No activity yet'}>
            {search || category
              ? 'Try another filter or search.'
              : 'Changes to the menu, prices, promotions, stock and staff will appear here.'}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="list activity">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {view.entries.map((e) => {
                  const d = describeActivity(e, money);
                  return (
                    <tr key={e.id}>
                      <td className="small muted nowrap">{when(e.at)}</td>
                      <td className="small">
                        {e.actor ?? e.device ?? 'System'}
                        {e.actor && e.device ? <div className="muted">on {e.device}</div> : null}
                      </td>
                      <td>
                        <strong>{d.what}</strong>
                        {e.entityLabel ? <div className="small">{e.entityLabel}</div> : null}
                      </td>
                      <td className="small">
                        {d.detail}
                        {e.reason ? <div className="muted">Reason: {e.reason}</div> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {view?.nextBefore ? (
          <div className="card-body center">
            <button type="button" className="btn" disabled={more} onClick={() => void loadMore()}>
              {more ? 'Loading…' : 'Show older activity'}
            </button>
          </div>
        ) : null}
      </section>
    </Shell>
  );
}
