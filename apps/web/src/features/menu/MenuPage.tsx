import type { ConfigEntity, ConfigurationView, InventoryItemView, MeView } from '@rp/contracts';
import { formatMinor } from '@rp/domain';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { explainRoute, routingFrom } from '../../infra/routing';
import { api, hasPermission } from '../../infra/session';
import { ErrorBox, Modal } from '../../ui/components';
import { preparePhoto } from '../../ui/photo';
import { Empty, Shell, Skeleton } from '../../ui/Shell';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export function useConfiguration() {
  const [config, setConfig] = useState<ConfigurationView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(() => {
    api.configuration().then(setConfig).catch(setError);
  }, []);
  useEffect(reload, [reload]);
  const save = useCallback(
    async (entity: ConfigEntity, record: Row) => {
      setError(null);
      try {
        const r = await api.saveConfig(entity, record);
        reload();
        return r.id;
      } catch (e) {
        setError(e);
        return null;
      }
    },
    [reload],
  );
  return { config, error, setError, reload, save };
}

type Dialog =
  | { kind: 'product'; product: Row | null }
  | { kind: 'recipe'; product: Row }
  | { kind: 'group'; group: Row | null }
  | { kind: 'category'; category: Row | null }
  | { kind: 'tax' };

export function MenuPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const { config, error, save, reload } = useConfiguration();
  const [tab, setTab] = useState<'products' | 'categories' | 'modifiers' | 'taxes'>('products');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [available, setAvailable] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api
      .menu(branchId)
      .then((m) => setAvailable(Object.fromEntries(m.products.map((p) => [p.id, p.isAvailable]))))
      .catch(() => undefined);
  }, [branchId]);

  const routing = useMemo(() => (config ? routingFrom(config) : null), [config]);
  const defaultArea = (config?.areas as Row[] | undefined)?.find(
    (a) => a.branchId === branchId && a.isActive,
  );
  const cats = (config?.categories ?? []) as Row[];
  const catName = (id: unknown) => str(cats.find((c) => c.id === id)?.name);
  const products = ((config?.products ?? []) as Row[]).filter(
    (p) =>
      (!category || p.categoryId === category) &&
      (!query || str(p.name).toLowerCase().includes(query.toLowerCase())),
  );
  const money = (m: number) => formatMinor(m, me.restaurant.currency);

  return (
    <Shell
      me={me}
      title="Menu"
      subtitle="Products, prices, modifiers and taxes. Changes appear on every POS immediately."
      actions={
        <button
          type="button"
          className="btn primary"
          onClick={() =>
            setDialog(
              tab === 'modifiers'
                ? { kind: 'group', group: null }
                : tab === 'categories'
                  ? { kind: 'category', category: null }
                  : tab === 'taxes'
                    ? { kind: 'tax' }
                    : { kind: 'product', product: null },
            )
          }
        >
          +{' '}
          {tab === 'modifiers'
            ? 'Modifier group'
            : tab === 'categories'
              ? 'Category'
              : tab === 'taxes'
                ? 'Tax rate'
                : 'Product'}
        </button>
      }
    >
      <ErrorBox error={error} />
      <div className="seg light page-tabs">
        {(
          [
            ['products', 'Products'],
            ['categories', 'Categories'],
            ['modifiers', 'Modifiers'],
            ['taxes', 'Taxes'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {!config || !routing ? (
        <Skeleton rows={8} />
      ) : tab === 'products' ? (
        <section className="card">
          <div className="toolbar">
            <input
              className="search"
              placeholder="Search products"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {cats.map((c) => (
                <option key={str(c.id)} value={str(c.id)}>
                  {str(c.name)}
                </option>
              ))}
            </select>
          </div>
          {config.products.length === 0 ? (
            <Empty
              title="No products yet"
              action={
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setDialog({ kind: 'product', product: null })}
                >
                  Add the first product
                </button>
              }
            >
              Create categories first (e.g. Main Meals, Drinks), then add products with their prices.
            </Empty>
          ) : (
            <table className="list">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Price</th>
                  <th>Routes to</th>
                  <th>Modifiers</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const route = defaultArea
                    ? explainRoute(
                        config,
                        routing,
                        { id: str(p.id), categoryId: str(p.categoryId) },
                        str(defaultArea.id),
                      )
                    : null;
                  const groups = ((p.modifierGroupIds ?? []) as string[])
                    .map((g) => str((config.modifierGroups as Row[]).find((x) => x.id === g)?.name))
                    .filter(Boolean);
                  const isAvailable = available[str(p.id)] ?? true;
                  return (
                    <tr key={str(p.id)} className={p.isActive ? '' : 'inactive'}>
                      <td>
                        <div className="row">
                          {p.imageUrl ? (
                            <img className="thumb" src={str(p.imageUrl)} alt="" loading="lazy" />
                          ) : (
                            <span className="thumb thumb-empty" aria-hidden>
                              {str(p.name).slice(0, 1)}
                            </span>
                          )}
                          <div>
                            <strong>{str(p.name)}</strong>
                            <div className="small muted">{catName(p.categoryId)}</div>
                          </div>
                        </div>
                      </td>
                      <td className="num">{money(Number(p.basePrice))}</td>
                      <td>
                        {route ? (
                          <span
                            className={route.stationId ? 'route' : 'pill danger'}
                            title={`by ${route.because}`}
                          >
                            → {route.stationName}
                          </span>
                        ) : null}
                      </td>
                      <td className="small">{groups.join(', ') || <span className="muted">—</span>}</td>
                      <td>
                        {!p.isActive ? (
                          <span className="pill">Inactive</span>
                        ) : isAvailable ? (
                          <span className="pill ok">On sale</span>
                        ) : (
                          <span className="pill danger">Sold out</span>
                        )}
                      </td>
                      <td className="actions-cell">
                        {p.isActive ? (
                          <button
                            type="button"
                            className="btn"
                            onClick={async () => {
                              if (
                                await save('branchProduct', {
                                  branchId,
                                  productId: p.id,
                                  isAvailable: !isAvailable,
                                })
                              )
                                setAvailable((a) => ({ ...a, [str(p.id)]: !isAvailable }));
                            }}
                          >
                            {isAvailable ? 'Mark sold out' : 'Back on sale'}
                          </button>
                        ) : null}
                        {hasPermission(me, 'inventory.manage') || hasPermission(me, 'menu.manage') ? (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setDialog({ kind: 'recipe', product: p })}
                          >
                            Recipe
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setDialog({ kind: 'product', product: p })}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      ) : tab === 'categories' ? (
        <section className="card">
          {cats.length === 0 ? (
            <Empty title="No categories yet">
              Categories group products on the POS and drive kitchen routing.
            </Empty>
          ) : (
            <table className="list">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Inside</th>
                  <th className="num">Products</th>
                  <th>Routes to</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {cats.map((c) => {
                  const rule = (config.routingRules as Row[]).find(
                    (r) => r.match === 'category' && r.categoryId === c.id && r.isActive,
                  );
                  return (
                    <tr key={str(c.id)}>
                      <td>
                        <strong>{str(c.name)}</strong>
                      </td>
                      <td className="muted">{catName(c.parentId) || '—'}</td>
                      <td className="num">
                        {(config.products as Row[]).filter((p) => p.categoryId === c.id).length}
                      </td>
                      <td>
                        {rule ? (
                          <span className="route">
                            → {str((config.stations as Row[]).find((s) => s.id === rule.stationId)?.name)}
                          </span>
                        ) : (
                          <span className="muted small">inherits / default</span>
                        )}
                      </td>
                      <td className="actions-cell">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setDialog({ kind: 'category', category: c })}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      ) : tab === 'modifiers' ? (
        <section className="card">
          {(config.modifierGroups as Row[]).length === 0 ? (
            <Empty title="No modifier groups yet">
              Modifiers are the options staff pick when ordering: spice level, extra protein, no ice…
            </Empty>
          ) : (
            <div className="groups">
              {(config.modifierGroups as Row[]).map((g) => {
                const mods = (config.modifiers as Row[]).filter((m) => m.groupId === g.id);
                const usedBy = (config.products as Row[]).filter((p) =>
                  ((p.modifierGroupIds ?? []) as string[]).includes(str(g.id)),
                );
                return (
                  <div key={str(g.id)} className="group-card">
                    <div className="row">
                      <strong className="grow">{str(g.name)}</strong>
                      <span className="small muted">
                        {g.maxSelect ? `choose up to ${str(g.maxSelect)}` : 'any number'}
                        {Number(g.minSelect) > 0 ? `, at least ${str(g.minSelect)}` : ''}
                      </span>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setDialog({ kind: 'group', group: g })}
                      >
                        Edit
                      </button>
                    </div>
                    <div className="chips">
                      {mods.map((m) => (
                        <span key={str(m.id)} className={`chip ${m.isActive ? '' : 'off'}`}>
                          {str(m.name)}
                          {Number(m.priceDelta) ? ` +${money(Number(m.priceDelta))}` : ''}
                        </span>
                      ))}
                    </div>
                    <div className="small muted">
                      Used by: {usedBy.map((p) => str(p.name)).join(', ') || 'no products yet'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ) : (
        <section className="card">
          {(config.taxRates as Row[]).length === 0 ? (
            <Empty title="No tax rates">
              Add the rates your accountant gives you. Prices can include tax or have it added.
            </Empty>
          ) : (
            <table className="list">
              <thead>
                <tr>
                  <th>Tax</th>
                  <th className="num">Rate</th>
                  <th>Applied</th>
                </tr>
              </thead>
              <tbody>
                {(config.taxRates as Row[]).map((t) => (
                  <tr key={str(t.id)}>
                    <td>{str(t.name)}</td>
                    <td className="num">{Number(t.rateBp) / 100}%</td>
                    <td>{t.isInclusive ? 'Included in prices' : 'Added on top'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {config && dialog?.kind === 'product' ? (
        <ProductDialog
          config={config}
          product={dialog.product}
          onClose={() => setDialog(null)}
          save={save}
          reload={reload}
        />
      ) : null}
      {config && dialog?.kind === 'recipe' ? (
        <RecipeDialog branchId={branchId} product={dialog.product} onClose={() => setDialog(null)} />
      ) : null}
      {config && dialog?.kind === 'group' ? (
        <GroupDialog
          config={config}
          group={dialog.group}
          onClose={() => setDialog(null)}
          save={save}
          reload={reload}
        />
      ) : null}
      {config && dialog?.kind === 'category' ? (
        <CategoryDialog
          config={config}
          category={dialog.category}
          onClose={() => setDialog(null)}
          save={save}
        />
      ) : null}
      {dialog?.kind === 'tax' ? <TaxDialog onClose={() => setDialog(null)} save={save} /> : null}
    </Shell>
  );
}

type Save = (entity: ConfigEntity, record: Row) => Promise<string | null>;

function ProductDialog({
  config,
  product,
  onClose,
  save,
  reload,
}: {
  config: ConfigurationView;
  product: Row | null;
  onClose: () => void;
  save: Save;
  reload: () => void;
}) {
  // Photo: uploaded straight away for an existing product; for a new one, right after it is created.
  const [photoUrl, setPhotoUrl] = useState<string | null>((product?.imageUrl as string | null) ?? null);
  const [pendingPhoto, setPendingPhoto] = useState<Blob | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<unknown>(null);
  useEffect(() => {
    if (!pendingPhoto) return;
    const url = URL.createObjectURL(pendingPhoto);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingPhoto]);
  async function choosePhoto(file: File | undefined) {
    if (!file) return;
    setPhotoError(null);
    setPhotoBusy(true);
    try {
      const blob = await preparePhoto(file);
      if (product) {
        const { imageUrl } = await api.setProductImage(str(product.id), blob);
        setPhotoUrl(imageUrl);
        reload();
      } else {
        setPendingPhoto(blob);
      }
    } catch (e) {
      setPhotoError(e);
    } finally {
      setPhotoBusy(false);
    }
  }
  async function removePhoto() {
    setPhotoError(null);
    if (!product) {
      setPendingPhoto(null);
      setPhotoUrl(null);
      return;
    }
    setPhotoBusy(true);
    try {
      await api.removeProductImage(str(product.id));
      setPhotoUrl(null);
      reload();
    } catch (e) {
      setPhotoError(e);
    } finally {
      setPhotoBusy(false);
    }
  }
  const [f, setF] = useState({
    name: str(product?.name),
    categoryId: str(product?.categoryId ?? (config.categories as Row[])[0]?.id),
    price: product ? String(Number(product.basePrice) / 100) : '',
    kitchenName: str(product?.kitchenName),
    taxRateIds: (product?.taxRateIds ??
      ((config.taxRates as Row[])[0] ? [(config.taxRates as Row[])[0]!.id] : [])) as string[],
    modifierGroupIds: (product?.modifierGroupIds ?? []) as string[],
    isActive: product ? Boolean(product.isActive) : true,
  });
  const [busy, setBusy] = useState(false);
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const id = await save('product', {
      id: product?.id,
      name: f.name,
      categoryId: f.categoryId,
      basePrice: Math.round(Number(f.price || 0) * 100),
      kitchenName: f.kitchenName || null,
      taxRateIds: f.taxRateIds,
      modifierGroupIds: f.modifierGroupIds,
      isActive: f.isActive,
    });
    if (id && pendingPhoto) {
      try {
        await api.setProductImage(id, pendingPhoto);
        reload();
      } catch (e) {
        // The product is saved; only the photo failed. Keep the dialog closed and say so.
        setPhotoError(e);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    if (id) onClose();
  }
  return (
    <Modal title={product ? `Edit ${str(product.name)}` : 'New product'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="photo-field">
          <div className="photo-frame">
            {photoUrl ? (
              <img src={photoUrl} alt={f.name || 'Product photo'} />
            ) : (
              <span className="photo-empty">No photo</span>
            )}
          </div>
          <div className="photo-actions">
            <strong>Photo</strong>
            <span className="small muted">
              Shown on the POS buttons. A clear, well-lit photo of the dish works best.
            </span>
            <div className="row">
              <label className={`btn sm ${photoBusy ? 'disabled' : ''}`}>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  disabled={photoBusy}
                  onChange={(e) => {
                    void choosePhoto(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
                {photoBusy ? 'Saving photo…' : photoUrl ? 'Change photo' : 'Add photo'}
              </label>
              {photoUrl ? (
                <button
                  type="button"
                  className="btn sm"
                  disabled={photoBusy}
                  onClick={() => void removePhoto()}
                >
                  Remove
                </button>
              ) : null}
            </div>
            {!product && pendingPhoto ? (
              <span className="small muted">The photo is saved with the product.</span>
            ) : null}
            <ErrorBox error={photoError} />
          </div>
        </div>
        <label>
          Name
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <div className="form-row">
          <label>
            Category
            <select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
              {(config.categories as Row[]).map((c) => (
                <option key={str(c.id)} value={str(c.id)}>
                  {str(c.name)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Price ({config.restaurant.currency})
            <input
              required
              type="number"
              min="0"
              step="0.01"
              value={f.price}
              onChange={(e) => setF({ ...f, price: e.target.value })}
            />
          </label>
        </div>
        <label>
          Name on kitchen tickets (optional)
          <input
            value={f.kitchenName}
            onChange={(e) => setF({ ...f, kitchenName: e.target.value })}
            placeholder="e.g. JOLLOF"
          />
        </label>
        <fieldset>
          <legend>Tax</legend>
          <div className="chips">
            {(config.taxRates as Row[]).map((t) => (
              <label
                key={str(t.id)}
                className={`chip selectable ${f.taxRateIds.includes(str(t.id)) ? 'on' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={f.taxRateIds.includes(str(t.id))}
                  onChange={() => setF({ ...f, taxRateIds: toggle(f.taxRateIds, str(t.id)) })}
                />
                {str(t.name)} {Number(t.rateBp) / 100}%
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Modifier groups</legend>
          <div className="chips">
            {(config.modifierGroups as Row[]).map((g) => (
              <label
                key={str(g.id)}
                className={`chip selectable ${f.modifierGroupIds.includes(str(g.id)) ? 'on' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={f.modifierGroupIds.includes(str(g.id))}
                  onChange={() => setF({ ...f, modifierGroupIds: toggle(f.modifierGroupIds, str(g.id)) })}
                />
                {str(g.name)}
              </label>
            ))}
            {(config.modifierGroups as Row[]).length === 0 ? (
              <span className="small muted">No modifier groups yet</span>
            ) : null}
          </div>
        </fieldset>
        {product ? (
          <label className="check">
            <input
              type="checkbox"
              checked={f.isActive}
              onChange={(e) => setF({ ...f, isActive: e.target.checked })}
            />{' '}
            Active (shown on the POS)
          </label>
        ) : null}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save product'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RecipeDialog({
  branchId,
  product,
  onClose,
}: {
  branchId: string;
  product: Row;
  onClose: () => void;
}) {
  const [items, setItems] = useState<InventoryItemView[] | null>(null);
  const [rows, setRows] = useState<{ itemId: string; quantity: string }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([api.inventory(branchId), api.recipe(str(product.id))])
      .then(([inv, recipe]) => {
        setItems(inv.items.filter((i) => i.isActive));
        setRows(recipe.map((r) => ({ itemId: r.itemId, quantity: String(r.quantity) })));
      })
      .catch(setError);
  }, [branchId, product.id]);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.saveRecipe(str(product.id), {
        components: rows
          .filter((r) => r.itemId && Number(r.quantity) > 0)
          .map((r) => ({ itemId: r.itemId, quantity: Number(r.quantity) })),
      });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const unit = (id: string) => items?.find((i) => i.id === id)?.unit ?? '';
  return (
    <Modal title={`Recipe — ${str(product.name)}`} onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>
        What ONE {str(product.name)} uses. When it is sent to the kitchen, these quantities are taken out of
        stock. Products without a recipe do not change stock.
      </p>
      {!items ? (
        <Skeleton />
      ) : items.length === 0 ? (
        <Empty title="No stock items yet">Add stock items in Inventory first.</Empty>
      ) : (
        <div className="form">
          {rows.map((r, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: editable rows
            <div key={n} className="form-row">
              <select
                value={r.itemId}
                onChange={(e) =>
                  setRows(rows.map((x, i) => (i === n ? { ...x, itemId: e.target.value } : x)))
                }
              >
                <option value="">Choose stock item</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.unit})
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0.001"
                step="0.001"
                placeholder={`quantity ${unit(r.itemId)}`}
                value={r.quantity}
                onChange={(e) =>
                  setRows(rows.map((x, i) => (i === n ? { ...x, quantity: e.target.value } : x)))
                }
              />
              <button
                type="button"
                className="btn"
                onClick={() => setRows(rows.filter((_, i) => i !== n))}
                aria-label="Remove"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() => setRows([...rows, { itemId: '', quantity: '' }])}
          >
            + Add ingredient
          </button>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy || !items} onClick={() => void submit()}>
          Save recipe
        </button>
      </div>
    </Modal>
  );
}

function GroupDialog({
  config,
  group,
  onClose,
  save,
  reload,
}: {
  config: ConfigurationView;
  group: Row | null;
  onClose: () => void;
  save: Save;
  reload: () => void;
}) {
  const [name, setName] = useState(str(group?.name));
  const [max, setMax] = useState(str(group?.maxSelect));
  const existing = (config.modifiers as Row[]).filter((m) => group && m.groupId === group.id);
  const [mods, setMods] = useState(
    existing.map((m) => ({
      id: str(m.id),
      name: str(m.name),
      price: String(Number(m.priceDelta) / 100),
      isActive: Boolean(m.isActive),
    })),
  );
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const groupId = await save('modifierGroup', {
      id: group?.id,
      name,
      minSelect: 0,
      maxSelect: max ? Number(max) : null,
    });
    if (groupId) {
      for (const [i, m] of mods.entries()) {
        if (!m.name.trim()) continue;
        await save('modifier', {
          id: m.id || undefined,
          groupId,
          name: m.name,
          priceDelta: Math.round(Number(m.price || 0) * 100),
          sortOrder: i,
          isActive: m.isActive,
        });
      }
      reload();
      onClose();
    }
    setBusy(false);
  }
  return (
    <Modal title={group ? `Edit ${str(group.name)}` : 'New modifier group'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-row">
          <label>
            Group name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Spice level"
            />
          </label>
          <label>
            Staff can choose up to
            <input
              type="number"
              min="1"
              value={max}
              onChange={(e) => setMax(e.target.value)}
              placeholder="any"
            />
          </label>
        </div>
        <fieldset>
          <legend>Options</legend>
          {mods.map((m, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: editable rows
            <div key={n} className="form-row">
              <input
                placeholder="Option name"
                value={m.name}
                onChange={(e) => setMods(mods.map((x, i) => (i === n ? { ...x, name: e.target.value } : x)))}
              />
              <input
                type="number"
                step="0.01"
                placeholder="Extra price"
                value={m.price}
                onChange={(e) => setMods(mods.map((x, i) => (i === n ? { ...x, price: e.target.value } : x)))}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={m.isActive}
                  onChange={(e) =>
                    setMods(mods.map((x, i) => (i === n ? { ...x, isActive: e.target.checked } : x)))
                  }
                />
                On
              </label>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() => setMods([...mods, { id: '', name: '', price: '', isActive: true }])}
          >
            + Add option
          </button>
        </fieldset>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save group'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CategoryDialog({
  config,
  category,
  onClose,
  save,
}: {
  config: ConfigurationView;
  category: Row | null;
  onClose: () => void;
  save: Save;
}) {
  const [name, setName] = useState(str(category?.name));
  const [parentId, setParentId] = useState(str(category?.parentId));
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (
      await save('category', {
        id: category?.id,
        name,
        parentId: parentId || null,
        sortOrder: Number(category?.sortOrder ?? 0),
      })
    )
      onClose();
  }
  return (
    <Modal title={category ? `Edit ${str(category.name)}` : 'New category'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Inside category (optional)
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">— top level —</option>
            {(config.categories as Row[])
              .filter((c) => c.id !== category?.id)
              .map((c) => (
                <option key={str(c.id)} value={str(c.id)}>
                  {str(c.name)}
                </option>
              ))}
          </select>
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TaxDialog({ onClose, save }: { onClose: () => void; save: Save }) {
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [inclusive, setInclusive] = useState(true);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await save('taxRate', { name, rateBp: Math.round(Number(rate) * 100), isInclusive: inclusive }))
      onClose();
  }
  return (
    <Modal title="New tax rate" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-row">
          <label>
            Name
            <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. VAT" />
          </label>
          <label>
            Rate (%)
            <input
              required
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={inclusive} onChange={(e) => setInclusive(e.target.checked)} />{' '}
          Prices already include this tax
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
