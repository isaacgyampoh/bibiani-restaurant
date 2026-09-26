import type { InventoryItemView, MeView, StockMovementView } from '@rp/contracts';
import { formatMinor, INVENTORY_UNITS } from '@rp/domain';
import { type FormEvent, useEffect, useState } from 'react';
import { linkTo } from '../../infra/router';
import { api, hasPermission } from '../../infra/session';
import { useFeed } from '../../infra/use-feed';
import { Badge, ErrorBox, Modal } from '../../ui/components';
import { Empty, Shell, Skeleton, Stat } from '../../ui/Shell';

const uuid = () => crypto.randomUUID();
const KIND: Record<StockMovementView['kind'], string> = {
  receive: 'Delivery',
  waste: 'Wastage',
  adjust: 'Adjustment',
  count: 'Stock count',
  sale: 'Sold',
  sale_reversal: 'Returned (order cancelled)',
};
const qty = (n: number, unit: string) => `${Number(n.toFixed(3)).toLocaleString()} ${unit}`;
const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';

type Dialog =
  | { kind: 'item'; item: InventoryItemView | null }
  | { kind: 'move'; item: InventoryItemView; move: 'receive' | 'waste' | 'adjust' }
  | { kind: 'history'; item: InventoryItemView };

export function InventoryPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const currency = me.restaurant.currency;
  const feed = useFeed(`inventory:${branchId}`, () => api.inventory(branchId), {
    topic: null,
    pollMs: 60_000,
  });
  const moves = useFeed(`moves:${branchId}`, () => api.stockMovements(branchId), {
    topic: null,
    pollMs: 60_000,
  });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [query, setQuery] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);
  const canManage = hasPermission(me, 'inventory.manage');
  const refresh = () => {
    feed.refresh();
    moves.refresh();
  };
  const inv = feed.data;
  const items = (inv?.items ?? []).filter(
    (i) =>
      (!onlyLow || i.isLow) &&
      (!query || `${i.name} ${i.category ?? ''} ${i.sku ?? ''}`.toLowerCase().includes(query.toLowerCase())),
  );
  const money = (m: number) => formatMinor(m, currency);

  return (
    <Shell
      me={me}
      title="Inventory"
      subtitle="Stock on hand, deliveries, wastage and adjustments. Every change is recorded."
      actions={
        <>
          <a className="btn" href="/stock-takes" onClick={linkTo('/stock-takes')}>
            Stock taking
          </a>
          {canManage ? (
            <button
              type="button"
              className="btn primary"
              onClick={() => setDialog({ kind: 'item', item: null })}
            >
              + Add stock item
            </button>
          ) : null}
        </>
      }
    >
      <ErrorBox error={feed.error} />
      {!inv ? (
        <Skeleton rows={8} />
      ) : (
        <>
          <div className="metrics">
            <Stat label="Stock items" value={inv.totals.items} />
            <Stat
              label="Low stock"
              value={inv.items.filter((i) => i.isActive && stockState(i) === 'low_stock').length}
              tone={inv.items.some((i) => i.isActive && stockState(i) === 'low_stock') ? 'warn' : undefined}
              hint="at or below minimum"
            />
            <Stat
              label="Out of stock"
              value={inv.items.filter((i) => i.isActive && stockState(i) === 'out_of_stock').length}
              tone={
                inv.items.some((i) => i.isActive && stockState(i) === 'out_of_stock') ? 'danger' : undefined
              }
              hint="none left"
            />
            <Stat label="Stock value" value={money(inv.totals.value)} hint="at unit cost" />
          </div>
          <section className="card">
            <div className="toolbar">
              <input
                className="search"
                placeholder="Search stock items"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <label className="check">
                <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> Low
                or out of stock only
              </label>
            </div>
            {inv.items.length === 0 ? (
              <Empty
                title="No stock items yet"
                action={
                  canManage ? (
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => setDialog({ kind: 'item', item: null })}
                    >
                      Add your first stock item
                    </button>
                  ) : null
                }
              >
                Add ingredients and supplies (rice, chicken, oil, drinks…) to track stock, deliveries and
                wastage.
              </Empty>
            ) : items.length === 0 ? (
              <Empty title="Nothing matches">Try another search or clear the low-stock filter.</Empty>
            ) : (
              <table className="list">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Status</th>
                    <th className="num">On hand</th>
                    <th className="num">Minimum</th>
                    <th className="num">Value</th>
                    <th>Last change</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} className={i.isActive ? '' : 'inactive'}>
                      <td>
                        <button
                          type="button"
                          className="linklike"
                          onClick={() => setDialog({ kind: 'history', item: i })}
                        >
                          <strong>{i.name}</strong>
                        </button>
                        <div className="small muted">
                          {[
                            i.category,
                            i.sku,
                            i.usedIn.length ? `used in ${i.usedIn.join(', ')}` : null,
                            i.isActive ? null : 'inactive',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </td>
                      <td>
                        <Badge value={stockState(i)} />
                      </td>
                      <td className="num">{qty(i.quantity, i.unit)}</td>
                      <td className="num muted">{qty(i.minQuantity, i.unit)}</td>
                      <td className="num">{money(i.value)}</td>
                      <td className="muted small">{when(i.lastMovementAt)}</td>
                      <td className="actions-cell">
                        {canManage && i.isActive ? (
                          <>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => setDialog({ kind: 'move', item: i, move: 'receive' })}
                            >
                              Receive
                            </button>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => setDialog({ kind: 'move', item: i, move: 'waste' })}
                            >
                              Waste
                            </button>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => setDialog({ kind: 'move', item: i, move: 'adjust' })}
                            >
                              Adjust
                            </button>
                          </>
                        ) : null}
                        {canManage ? (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setDialog({ kind: 'item', item: i })}
                          >
                            Edit
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="card">
            <div className="card-head">
              <h2>Recent stock movements</h2>
            </div>
            <MovementTable rows={moves.data ?? []} showItem />
          </section>
        </>
      )}
      {dialog?.kind === 'item' ? (
        <ItemDialog
          branchId={branchId}
          item={dialog.item}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            refresh();
          }}
        />
      ) : null}
      {dialog?.kind === 'move' ? (
        <MoveDialog
          item={dialog.item}
          move={dialog.move}
          currency={currency}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            refresh();
          }}
        />
      ) : null}
      {dialog?.kind === 'history' ? (
        <HistoryDialog branchId={branchId} item={dialog.item} onClose={() => setDialog(null)} />
      ) : null}
    </Shell>
  );
}

function MovementTable({ rows, showItem }: { rows: StockMovementView[]; showItem?: boolean }) {
  if (rows.length === 0)
    return <Empty title="No stock movements yet">Deliveries, wastage, counts and sales appear here.</Empty>;
  return (
    <table className="list">
      <thead>
        <tr>
          <th>When</th>
          {showItem ? <th>Item</th> : null}
          <th>Type</th>
          <th className="num">Change</th>
          <th className="num">After</th>
          <th>Reason / reference</th>
          <th>By</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.id}>
            <td className="small">{when(m.createdAt)}</td>
            {showItem ? <td>{m.itemName}</td> : null}
            <td>
              <span className={`pill ${m.kind}`}>{KIND[m.kind]}</span>
            </td>
            <td className={`num ${m.quantityDelta < 0 ? 'neg' : 'plus'}`}>
              {m.quantityDelta > 0 ? '+' : ''}
              {qty(m.quantityDelta, m.unit)}
            </td>
            <td className="num">{qty(m.quantityAfter, m.unit)}</td>
            <td className="small">
              {[m.reason, m.reference].filter(Boolean).join(' · ') || <span className="muted">—</span>}
            </td>
            <td className="small muted">{m.staffName ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HistoryDialog({
  branchId,
  item,
  onClose,
}: {
  branchId: string;
  item: InventoryItemView;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<StockMovementView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.stockMovements(branchId, item.id).then(setRows).catch(setError);
  }, [branchId, item.id]);
  return (
    <Modal title={`${item.name} — history`} onClose={onClose}>
      <div className="small muted" style={{ marginBottom: 8 }}>
        On hand: <strong>{qty(item.quantity, item.unit)}</strong> · minimum {qty(item.minQuantity, item.unit)}
      </div>
      <ErrorBox error={error} />
      {rows ? <MovementTable rows={rows} /> : <Skeleton />}
    </Modal>
  );
}

function ItemDialog({
  branchId,
  item,
  onClose,
  onSaved,
}: {
  branchId: string;
  item: InventoryItemView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: item?.name ?? '',
    category: item?.category ?? '',
    sku: item?.sku ?? '',
    unit: item?.unit ?? 'kg',
    minQuantity: String(item?.minQuantity ?? ''),
    unitCost: item ? String(item.unitCost / 100) : '',
    isActive: item?.isActive ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.saveInventoryItem({
        id: item?.id,
        branchId,
        name: f.name,
        category: f.category || null,
        sku: f.sku || null,
        unit: f.unit as (typeof INVENTORY_UNITS)[number],
        minQuantity: Number(f.minQuantity || 0),
        unitCost: Math.round(Number(f.unitCost || 0) * 100),
        isActive: f.isActive,
      });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={item ? `Edit ${item.name}` : 'New stock item'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <input
            required
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder="e.g. Chicken breast"
          />
        </label>
        <div className="form-row">
          <label>
            Category
            <input
              value={f.category}
              onChange={(e) => setF({ ...f, category: e.target.value })}
              placeholder="e.g. Meat"
            />
          </label>
          <label>
            SKU / code
            <input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Unit
            <select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>
              {INVENTORY_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
          <label>
            Minimum stock
            <input
              type="number"
              min="0"
              step="0.001"
              value={f.minQuantity}
              onChange={(e) => setF({ ...f, minQuantity: e.target.value })}
            />
          </label>
          <label>
            Cost per {f.unit}
            <input
              type="number"
              min="0"
              step="0.01"
              value={f.unitCost}
              onChange={(e) => setF({ ...f, unitCost: e.target.value })}
            />
          </label>
        </div>
        {item ? (
          <label className="check">
            <input
              type="checkbox"
              checked={f.isActive}
              onChange={(e) => setF({ ...f, isActive: e.target.checked })}
            />{' '}
            Active
          </label>
        ) : (
          <div className="small muted">Stock starts at zero. Record the opening quantity as a delivery.</div>
        )}
        <ErrorBox error={error} />
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MoveDialog({
  item,
  move,
  currency,
  onClose,
  onSaved,
}: {
  item: InventoryItemView;
  move: 'receive' | 'waste' | 'adjust';
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [movementId] = useState(uuid);
  const [quantity, setQuantity] = useState('');
  const [direction, setDirection] = useState<1 | -1>(1);
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const n = Number(quantity || 0) * (move === 'adjust' ? direction : move === 'waste' ? -1 : 1);
  const after = item.quantity + n;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.recordStockMovement({
        movementId,
        itemId: item.id,
        kind: move,
        quantity: move === 'adjust' ? n : Number(quantity),
        reason: reason || null,
        reference: reference || null,
        unitCost: unitCost ? Math.round(Number(unitCost) * 100) : null,
      });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  const title =
    move === 'receive' ? 'Receive delivery' : move === 'waste' ? 'Record wastage' : 'Adjust stock';
  return (
    <Modal title={`${title} — ${item.name}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {move === 'adjust' ? (
          <div className="seg light">
            <button type="button" className={direction === 1 ? 'on' : ''} onClick={() => setDirection(1)}>
              Add
            </button>
            <button type="button" className={direction === -1 ? 'on' : ''} onClick={() => setDirection(-1)}>
              Remove
            </button>
          </div>
        ) : null}
        <label>
          Quantity ({item.unit})
          <input
            required
            type="number"
            min="0.001"
            step="0.001"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
        {move === 'receive' ? (
          <div className="form-row">
            <label>
              Invoice / delivery note
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="e.g. INV-2041"
              />
            </label>
            <label>
              Cost per {item.unit} (optional)
              <input
                type="number"
                min="0"
                step="0.01"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
              />
            </label>
          </div>
        ) : (
          <label>
            Reason
            <input
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                move === 'waste' ? 'e.g. Spoiled, dropped, expired' : 'e.g. Found extra bag in store'
              }
            />
          </label>
        )}
        <div className="summary-line">
          On hand {qty(item.quantity, item.unit)} →{' '}
          <strong className={after < 0 ? 'neg' : ''}>{qty(after, item.unit)}</strong>
          {item.unitCost ? (
            <span className="muted">
              {' '}
              · value {formatMinor(Math.round(Math.max(0, after) * item.unitCost), currency)}
            </span>
          ) : null}
        </div>
        <ErrorBox error={error} />
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !quantity}>
            {busy ? 'Saving…' : title}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** In stock / Low stock (at or below minimum) / Out of stock (nothing left). */
function stockState(i: { quantity: number; isLow: boolean }): 'in_stock' | 'low_stock' | 'out_of_stock' {
  return i.quantity <= 0 ? 'out_of_stock' : i.isLow ? 'low_stock' : 'in_stock';
}
