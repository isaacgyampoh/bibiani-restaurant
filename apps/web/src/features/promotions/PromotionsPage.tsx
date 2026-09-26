import type {
  MenuView,
  MeView,
  PromotionPreviewView,
  PromotionView,
  SavePromotionCommand,
} from '@rp/contracts';
import { formatMinor } from '@rp/domain';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../infra/session';
import { Alert, Badge, Drawer, ErrorBox, Field, FormSection, Modal, useToast } from '../../ui/components';
import { Empty, Shell, Skeleton } from '../../ui/Shell';

type Tab = 'active' | 'upcoming' | 'paused' | 'ended' | 'all';
const TABS: [Tab, string, (p: PromotionView) => boolean][] = [
  ['active', 'Running', (p) => p.phase === 'live' || p.phase === 'scheduled'],
  ['upcoming', 'Upcoming', (p) => p.phase === 'upcoming'],
  ['paused', 'Paused', (p) => p.phase === 'paused'],
  ['ended', 'Ended', (p) => p.phase === 'ended'],
  ['all', 'All', () => true],
];
const KIND_LABEL: Record<PromotionView['kind'], string> = {
  percent_off: 'Percentage off',
  amount_off: 'Amount off',
  fixed_price: 'Promotional price',
  bundle_price: 'Bundle price',
  buy_get_free: 'Buy X get Y free',
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const toMinor = (v: string) => Math.round(Number(v || 0) * 100);
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Automatic promotions: created, previewed, scheduled, paused and ended here; applied by the server. */
export function PromotionsPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const [list, setList] = useState<PromotionView[] | null>(null);
  const [menu, setMenu] = useState<MenuView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>('active');
  const [editing, setEditing] = useState<PromotionView | 'new' | null>(null);
  const [ending, setEnding] = useState<PromotionView | null>(null);
  const toast = useToast();
  const reload = useCallback(() => {
    api.promotions().then(setList).catch(setError);
  }, []);
  useEffect(() => {
    reload();
    if (branchId) api.menu(branchId).then(setMenu).catch(setError);
  }, [reload, branchId]);

  const currency = menu?.currency ?? me.restaurant.currency;
  const money = (m: number) => formatMinor(m, currency);
  const productName = new Map(menu?.products.map((p) => [p.id, p]) ?? []);
  const categoryName = new Map(menu?.categories.map((c) => [c.id, c.name]) ?? []);
  const targets = (p: PromotionView) =>
    p.appliesToAll
      ? 'Everything on the menu'
      : [
          ...p.categoryIds.map((id) => `${categoryName.get(id) ?? 'Category'} (all)`),
          ...p.productIds.map((id) => productName.get(id)?.name ?? 'Product'),
        ].join(', ');
  /** Normal and promotional price, when the promotion targets a single product. */
  const pricePair = (p: PromotionView) => {
    const only = !p.appliesToAll && p.categoryIds.length === 0 && p.productIds.length === 1;
    const product = only ? productName.get(p.productIds[0]!) : undefined;
    if (!product) return null;
    const n =
      p.kind === 'bundle_price'
        ? (p.bundleQuantity ?? 1)
        : p.kind === 'buy_get_free'
          ? (p.bundleQuantity ?? 0) + (p.freeQuantity ?? 0)
          : 1;
    const normal = product.price * n;
    const promo =
      p.kind === 'buy_get_free'
        ? product.price * (p.bundleQuantity ?? 0)
        : p.kind === 'percent_off'
          ? normal - Math.round((normal * (p.percentBp ?? 0)) / 10_000)
          : p.kind === 'amount_off'
            ? Math.max(0, product.price - (p.amount ?? 0)) * n
            : p.kind === 'fixed_price'
              ? Math.min(product.price, p.amount ?? product.price)
              : Math.min(normal, p.amount ?? normal);
    return { n, normal, promo };
  };

  async function setStatus(p: PromotionView, action: 'activate' | 'pause' | 'end') {
    setError(null);
    setEnding(null);
    try {
      await api.setPromotionStatus(p.id, action, p.version);
      toast(
        action === 'end'
          ? `${p.name} ended. Orders already taken keep their prices.`
          : action === 'pause'
            ? `${p.name} paused`
            : `${p.name} is on`,
      );
      reload();
    } catch (e) {
      setError(e);
    }
  }

  const shown = (list ?? []).filter(TABS.find(([k]) => k === tab)![2]);
  return (
    <Shell
      me={me}
      title="Promotions"
      subtitle="Automatic prices the tills apply by themselves. Orders keep the price they were taken at."
      actions={
        <button type="button" className="btn primary" onClick={() => setEditing('new')} disabled={!menu}>
          New promotion
        </button>
      }
    >
      <ErrorBox error={error} />
      <div className="tabs-line" role="tablist">
        {TABS.map(([k, label, pred]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? 'on' : ''}
            onClick={() => setTab(k)}
          >
            {label}
            {list ? <span className="count">{list.filter(pred).length}</span> : null}
          </button>
        ))}
      </div>
      {!list ? (
        <Skeleton rows={5} />
      ) : (
        <section className="card">
          {shown.length === 0 ? (
            <Empty
              title={tab === 'active' ? 'No promotions running' : 'Nothing here'}
              action={
                tab === 'active' ? (
                  <button type="button" className="btn primary" onClick={() => setEditing('new')}>
                    Create a promotion
                  </button>
                ) : null
              }
            >
              {tab === 'active'
                ? 'For example “Jollof Friday: 10% off rice dishes” or “3 Kebabs for GH₵25”.'
                : null}
            </Empty>
          ) : (
            <div className="table-scroll">
              <table className="list">
                <thead>
                  <tr>
                    <th>Promotion</th>
                    <th>Applies to</th>
                    <th className="num">Normal / promo</th>
                    <th>When</th>
                    <th>Status</th>
                    <th>Last change</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => {
                    const pair = pricePair(p);
                    return (
                      <tr key={p.id}>
                        <td>
                          <strong>{p.name}</strong>
                          <div className="small muted">
                            {KIND_LABEL[p.kind]}
                            {p.priority ? ` · priority ${p.priority}` : ''}
                          </div>
                        </td>
                        <td className="small">{targets(p)}</td>
                        <td className="num small">
                          {pair ? (
                            <>
                              {pair.n > 1 ? `${pair.n} × ` : ''}
                              <s className="muted">{money(pair.normal)}</s>{' '}
                              <strong>{money(pair.promo)}</strong>
                            </>
                          ) : (
                            <span className="muted">{p.summary.split(' · ')[0]}</span>
                          )}
                        </td>
                        <td className="small">{p.summary.split(' · ').slice(1).join(' · ') || 'Always'}</td>
                        <td>
                          <Badge value={`promo_${p.phase}`} />
                        </td>
                        <td className="small muted">
                          {p.updatedBy ?? p.createdBy ?? '—'}
                          <div>{when(p.updatedAt)}</div>
                        </td>
                        <td className="actions-cell">
                          {p.phase !== 'ended' ? (
                            <>
                              <button type="button" className="btn sm" onClick={() => setEditing(p)}>
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn sm"
                                onClick={() =>
                                  void setStatus(p, p.status === 'paused' ? 'activate' : 'pause')
                                }
                              >
                                {p.status === 'paused' ? 'Turn on' : 'Pause'}
                              </button>
                              <button type="button" className="btn sm danger" onClick={() => setEnding(p)}>
                                End
                              </button>
                            </>
                          ) : (
                            <button type="button" className="btn sm" onClick={() => setEditing(p)}>
                              Reuse
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      <p className="small muted">
        Rules: a promotion discounts the item’s normal price (extras are charged in full) and never goes below
        zero. Promotions never add up: when two could apply, the higher priority wins, then the bigger saving.
        Two promotions with the same priority on the same items at the same time are refused.
      </p>
      {ending ? (
        <Modal
          title={`End ${ending.name}?`}
          onClose={() => setEnding(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEnding(null)}>
                Keep it
              </button>
              <button type="button" className="btn danger" onClick={() => void setStatus(ending, 'end')}>
                End promotion
              </button>
            </>
          }
        >
          <p className="muted">
            New orders pay the normal price from now on. Orders already taken keep the promotional price, and
            the promotion stays in the history.
          </p>
        </Modal>
      ) : null}
      {editing && menu ? (
        <PromotionDrawer
          menu={menu}
          promotion={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null);
            toast(`${name} saved`);
            reload();
          }}
        />
      ) : null}
    </Shell>
  );
}

function PromotionDrawer({
  menu,
  promotion,
  onClose,
  onSaved,
}: {
  menu: MenuView;
  promotion: PromotionView | null;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  // An ended promotion is reused as a new one (its history stays untouched).
  const reuse = promotion?.phase === 'ended';
  const initial = useMemo(
    () => ({
      name: promotion ? (reuse ? `${promotion.name}` : promotion.name) : '',
      kind: promotion?.kind ?? ('percent_off' as PromotionView['kind']),
      percent: promotion?.percentBp ? String(promotion.percentBp / 100) : '10',
      amount:
        promotion?.amount !== null && promotion?.amount !== undefined ? String(promotion.amount / 100) : '',
      bundleQuantity: String(promotion?.bundleQuantity ?? (promotion?.kind === 'buy_get_free' ? 2 : 3)),
      freeQuantity: String(promotion?.freeQuantity ?? 1),
      appliesToAll: promotion?.appliesToAll ?? false,
      productIds: promotion?.productIds ?? [],
      categoryIds: promotion?.categoryIds ?? [],
      startsOn: reuse ? '' : (promotion?.startsOn ?? ''),
      endsOn: reuse ? '' : (promotion?.endsOn ?? ''),
      days: promotion?.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6],
      timed: Boolean(promotion?.startTime),
      startTime: promotion?.startTime ?? '11:00',
      endTime: promotion?.endTime ?? '14:00',
      priority: String(promotion?.priority ?? 0),
      paused: promotion?.status === 'paused',
    }),
    [promotion, reuse],
  );
  const [f, setF] = useState(initial);
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<PromotionPreviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const money = (m: number) => formatMinor(m, menu.currency);
  const toggle = (list: readonly (string | number)[], v: string | number) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const command = useMemo(
    (): SavePromotionCommand => ({
      id: promotion && !reuse ? promotion.id : null,
      expectedVersion: promotion && !reuse ? promotion.version : null,
      name: f.name.trim() || 'Untitled',
      kind: f.kind,
      percentBp: f.kind === 'percent_off' ? Math.round(Number(f.percent || 0) * 100) : null,
      amount: f.kind === 'percent_off' || f.kind === 'buy_get_free' ? null : toMinor(f.amount),
      bundleQuantity:
        f.kind === 'bundle_price' || f.kind === 'buy_get_free' ? Number(f.bundleQuantity || 0) : null,
      freeQuantity: f.kind === 'buy_get_free' ? Number(f.freeQuantity || 0) : null,
      appliesToAll: f.appliesToAll,
      productIds: f.appliesToAll ? [] : f.productIds,
      categoryIds: f.appliesToAll ? [] : f.categoryIds,
      startsOn: f.startsOn || null,
      endsOn: f.endsOn || null,
      daysOfWeek: f.days.length === 7 ? null : [...f.days].sort(),
      startTime: f.timed ? f.startTime : null,
      endTime: f.timed ? f.endTime : null,
      priority: Number(f.priority || 0),
      status: f.paused ? 'paused' : 'active',
    }),
    [f, promotion, reuse],
  );

  // Live preview (debounced): what it costs on each item, when it runs, and any clash.
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .previewPromotion(command)
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(t);
  }, [command]);

  function close() {
    if (dirty && !window.confirm('Discard your changes to this promotion?')) return;
    onClose();
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.savePromotion({ ...command, name: f.name.trim() });
      onSaved(f.name.trim());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const q = search.trim().toLowerCase();
  const products = menu.products.filter((p) => !q || p.name.toLowerCase().includes(q));
  const blocked = !preview?.valid || (preview?.conflicts.length ?? 0) > 0 || !f.name.trim();
  return (
    <Drawer
      title={promotion && !reuse ? `Edit ${promotion.name}` : 'New promotion'}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="promo-form" className="btn primary" disabled={busy || blocked}>
            {busy ? 'Saving…' : f.paused ? 'Save (paused)' : 'Save and turn on'}
          </button>
        </>
      }
    >
      <form id="promo-form" onSubmit={submit}>
        <FormSection title="Promotion" description="Shown on the till, the receipt and the kitchen screen.">
          <Field label="Name" required>
            <input
              required
              maxLength={60}
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
              placeholder="e.g. Jollof Friday"
            />
          </Field>
          <fieldset>
            <legend>Type</legend>
            <div className="seg">
              {(Object.keys(KIND_LABEL) as PromotionView['kind'][]).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={f.kind === k}
                  className={f.kind === k ? 'on' : ''}
                  onClick={() => setF({ ...f, kind: k })}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="form-row">
            {f.kind === 'percent_off' ? (
              <Field label="Percentage off" hint="Up to 100%">
                <input
                  type="number"
                  min={0.01}
                  max={100}
                  step={0.01}
                  value={f.percent}
                  onChange={(e) => setF({ ...f, percent: e.target.value })}
                />
              </Field>
            ) : null}
            {f.kind === 'bundle_price' ? (
              <Field label="Items in the bundle">
                <input
                  type="number"
                  min={2}
                  max={99}
                  value={f.bundleQuantity}
                  onChange={(e) => setF({ ...f, bundleQuantity: e.target.value })}
                />
              </Field>
            ) : null}
            {f.kind === 'buy_get_free' ? (
              <>
                <Field label="Customer buys">
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={f.bundleQuantity}
                    onChange={(e) => setF({ ...f, bundleQuantity: e.target.value })}
                  />
                </Field>
                <Field label="Gets free">
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={f.freeQuantity}
                    onChange={(e) => setF({ ...f, freeQuantity: e.target.value })}
                  />
                </Field>
              </>
            ) : null}
            {f.kind !== 'percent_off' && f.kind !== 'buy_get_free' ? (
              <Field
                label={
                  f.kind === 'amount_off'
                    ? `Amount off each (${menu.currency})`
                    : f.kind === 'fixed_price'
                      ? `Promotional price each (${menu.currency})`
                      : `Bundle price (${menu.currency})`
                }
              >
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={f.amount}
                  onChange={(e) => setF({ ...f, amount: e.target.value })}
                />
              </Field>
            ) : null}
          </div>
        </FormSection>

        <FormSection title="Applies to" description="Whole categories include the categories inside them.">
          <label className="check">
            <input
              type="checkbox"
              checked={f.appliesToAll}
              onChange={(e) => setF({ ...f, appliesToAll: e.target.checked })}
            />
            Everything on the menu
          </label>
          {!f.appliesToAll ? (
            <>
              <fieldset>
                <legend>Categories</legend>
                <div className="chips">
                  {menu.categories.map((c) => (
                    <label
                      key={c.id}
                      className={`chip selectable ${f.categoryIds.includes(c.id) ? 'on' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={f.categoryIds.includes(c.id)}
                        onChange={() => setF({ ...f, categoryIds: toggle(f.categoryIds, c.id) as string[] })}
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Products</legend>
                <input
                  className="search"
                  placeholder="Search products"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="chips">
                  {products.map((p) => (
                    <label
                      key={p.id}
                      className={`chip selectable ${f.productIds.includes(p.id) ? 'on' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={f.productIds.includes(p.id)}
                        onChange={() => setF({ ...f, productIds: toggle(f.productIds, p.id) as string[] })}
                      />
                      {p.name} · {money(p.price)}
                    </label>
                  ))}
                </div>
              </fieldset>
            </>
          ) : null}
        </FormSection>

        <FormSection
          title="When"
          description="Restaurant time. Leave the dates empty to start now and never end."
        >
          <div className="form-row">
            <Field label="Starts on">
              <input
                type="date"
                value={f.startsOn}
                onChange={(e) => setF({ ...f, startsOn: e.target.value })}
              />
            </Field>
            <Field label="Ends on (last day)">
              <input type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} />
            </Field>
          </div>
          <fieldset>
            <legend>Days</legend>
            <div className="chips">
              {DAYS.map((d, i) => (
                <label key={d} className={`chip selectable ${f.days.includes(i) ? 'on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={f.days.includes(i)}
                    onChange={() => setF({ ...f, days: toggle(f.days, i) as number[] })}
                  />
                  {d}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="check">
            <input
              type="checkbox"
              checked={f.timed}
              onChange={(e) => setF({ ...f, timed: e.target.checked })}
            />
            Only at certain times of day
          </label>
          {f.timed ? (
            <div className="form-row">
              <Field label="From">
                <input
                  type="time"
                  value={f.startTime}
                  onChange={(e) => setF({ ...f, startTime: e.target.value })}
                />
              </Field>
              <Field label="Until" hint="May be after midnight, e.g. 22:00 to 02:00">
                <input
                  type="time"
                  value={f.endTime}
                  onChange={(e) => setF({ ...f, endTime: e.target.value })}
                />
              </Field>
            </div>
          ) : null}
        </FormSection>

        <FormSection
          title="Priority"
          description="When two promotions could apply to the same item, the higher priority wins."
        >
          <div className="form-row">
            <Field label="Priority (0–100)">
              <input
                type="number"
                min={0}
                max={100}
                value={f.priority}
                onChange={(e) => setF({ ...f, priority: e.target.value })}
              />
            </Field>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={f.paused}
              onChange={(e) => setF({ ...f, paused: e.target.checked })}
            />
            Save it paused (turn it on later)
          </label>
        </FormSection>

        <FormSection
          title="Preview"
          description="Exactly what the tills will charge. Nothing changes until you save."
        >
          {!preview ? (
            <div className="muted small">Working it out…</div>
          ) : !preview.valid ? (
            <Alert tone="warn">{preview.error}</Alert>
          ) : (
            <>
              <div>
                <strong>{preview.summary}</strong>{' '}
                <Badge value={`promo_${f.paused ? 'paused' : preview.phase}`} />
              </div>
              {preview.conflicts.length ? (
                <Alert tone="danger">
                  Clashes with {preview.conflicts.join(', ')}: same items, same time, same priority. Change
                  the priority so it is clear which price applies.
                </Alert>
              ) : null}
              {preview.lines.length === 0 ? (
                <div className="muted small">No products selected yet.</div>
              ) : (
                <table className="list compact">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Normal</th>
                      <th className="num">With promotion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.lines.slice(0, 30).map((l) => (
                      <tr key={l.productId}>
                        <td>
                          {l.quantity > 1 ? `${l.quantity} × ` : ''}
                          {l.name}
                        </td>
                        <td className="num muted">{money(l.normalPrice)}</td>
                        <td className="num">
                          <strong>{money(l.promoPrice)}</strong>
                          {l.promoPrice === l.normalPrice ? (
                            <div className="small muted">no saving</div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {preview.lines.length > 30 ? (
                <div className="small muted">…and {preview.lines.length - 30} more items</div>
              ) : null}
            </>
          )}
        </FormSection>
        <ErrorBox error={error} />
      </form>
    </Drawer>
  );
}
