import type { ConfigurationView, InventoryItemView, MeView, PromotionView } from '@rp/contracts';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { linkTo } from '../../infra/router';
import { explainRoute, routingFrom } from '../../infra/routing';
import { api, hasPermission } from '../../infra/session';
import { Alert, Badge, Drawer, errorMessage, Field, FormSection } from '../../ui/components';
import { Icon } from '../../ui/icons';
import { preparePhoto } from '../../ui/photo';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
/** Originals larger than this are refused before resizing (phone photos are usually 2-8 MB). */
const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;

type PhotoState =
  | { kind: 'idle' }
  | { kind: 'working'; label: string }
  | { kind: 'done'; label: string }
  | { kind: 'error'; message: string };

/**
 * One product, in the order a manager thinks about it: what it is, what it costs and whether it is on
 * sale, how it looks, what it uses, and where the kitchen makes it. Saved together; a photo on an
 * existing product is saved as soon as it is chosen.
 */
export function ProductEditor({
  me,
  config,
  branchId,
  product,
  available,
  onClose,
  onSaved,
}: {
  me: MeView;
  config: ConfigurationView;
  branchId: string;
  product: Row | null;
  available: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const currency = config.restaurant.currency;
  const categories = config.categories as Row[];
  const [productId, setProductId] = useState<string | null>(product ? str(product.id) : null);
  const initial = useMemo(
    () => ({
      name: str(product?.name),
      description: str(product?.description),
      categoryId: str(product?.categoryId ?? categories[0]?.id),
      price: product ? String(Number(product.basePrice) / 100) : '',
      available,
      kitchenName: str(product?.kitchenName),
      taxRateIds: (product?.taxRateIds ??
        ((config.taxRates as Row[])[0] ? [(config.taxRates as Row[])[0]!.id] : [])) as string[],
      modifierGroupIds: (product?.modifierGroupIds ?? []) as string[],
      isActive: product ? Boolean(product.isActive) : true,
    }),
    [product, available, categories, config.taxRates],
  );
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Recipe (ingredients from stock).
  const canRecipe = hasPermission(me, 'menu.manage');
  const [stockItems, setStockItems] = useState<InventoryItemView[] | null>(null);
  const [recipe, setRecipe] = useState<{ itemId: string; quantity: string }[]>([]);
  const [recipeInitial, setRecipeInitial] = useState('[]');
  useEffect(() => {
    if (!canRecipe) return;
    Promise.all([api.inventory(branchId), product ? api.recipe(str(product.id)) : Promise.resolve([])])
      .then(([inv, rows]) => {
        setStockItems(inv.items.filter((i) => i.isActive));
        const r = rows.map((x) => ({ itemId: x.itemId, quantity: String(x.quantity) }));
        setRecipe(r);
        setRecipeInitial(JSON.stringify(r));
      })
      .catch(() => setStockItems([]));
  }, [branchId, product, canRecipe]);

  // Promotions that affect this product (read-only here; managed on the Promotions page).
  const [promotions, setPromotions] = useState<PromotionView[] | null>(null);
  useEffect(() => {
    if (!hasPermission(me, 'promotions.manage')) return;
    api
      .promotions()
      .then(setPromotions)
      .catch(() => setPromotions(null));
  }, [me]);
  const categoryPath = useMemo(() => {
    const parent = new Map(categories.map((c) => [str(c.id), (c.parentId ?? null) as string | null]));
    const path: string[] = [];
    for (let c: string | null | undefined = f.categoryId; c && !path.includes(c); c = parent.get(c))
      path.push(c);
    return path;
  }, [categories, f.categoryId]);
  const affecting = (promotions ?? []).filter(
    (p) =>
      p.phase !== 'ended' &&
      (p.appliesToAll ||
        (productId !== null && p.productIds.includes(productId)) ||
        categoryPath.some((c) => p.categoryIds.includes(c))),
  );

  // Where the kitchen makes it (the same routing the server uses).
  const routing = useMemo(() => routingFrom(config), [config]);
  const area = (config.areas as Row[]).find((a) => a.branchId === branchId && a.isActive);
  const route =
    area && f.categoryId
      ? explainRoute(config, routing, { id: productId ?? 'new', categoryId: f.categoryId }, str(area.id))
      : null;

  // Photo.
  const [photoUrl, setPhotoUrl] = useState<string | null>((product?.imageUrl as string | null) ?? null);
  const [pendingPhoto, setPendingPhoto] = useState<Blob | null>(null);
  const [pendingThumb, setPendingThumb] = useState<Blob | null>(null);
  const [photo, setPhoto] = useState<PhotoState>({ kind: 'idle' });
  useEffect(() => {
    if (!pendingPhoto) return;
    const url = URL.createObjectURL(pendingPhoto);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingPhoto]);
  async function choosePhoto(file: File | undefined) {
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      setPhoto({ kind: 'error', message: 'This file is not a JPEG, PNG or WebP photo.' });
      return;
    }
    if (file.size > MAX_ORIGINAL_BYTES) {
      setPhoto({ kind: 'error', message: 'This photo is too large (over 25 MB). Choose a smaller one.' });
      return;
    }
    const replacing = Boolean(photoUrl);
    try {
      setPhoto({ kind: 'working', label: 'Preparing photo…' });
      const blob = await preparePhoto(file);
      const thumb = await preparePhoto(file, 320);
      if (!productId) {
        setPendingPhoto(blob);
        setPendingThumb(thumb);
        setPhoto({ kind: 'done', label: 'Photo ready. It is saved with the product.' });
        return;
      }
      setPhoto({ kind: 'working', label: 'Uploading…' });
      const { imageUrl } = await api.setProductImage(productId, blob);
      // Small version for POS buttons; the photo still works without it.
      await api.setProductImageThumb(productId, thumb).catch(() => undefined);
      setPhotoUrl(imageUrl);
      setPhoto({ kind: 'done', label: replacing ? 'Photo replaced' : 'Photo saved' });
    } catch (e) {
      setPhoto({ kind: 'error', message: errorMessage(e) });
    }
  }
  async function removePhoto() {
    if (!productId) {
      setPendingPhoto(null);
      setPhotoUrl(null);
      setPhoto({ kind: 'idle' });
      return;
    }
    try {
      setPhoto({ kind: 'working', label: 'Removing…' });
      await api.removeProductImage(productId);
      setPhotoUrl(null);
      setPhoto({ kind: 'done', label: 'Photo removed' });
    } catch (e) {
      setPhoto({ kind: 'error', message: errorMessage(e) });
    }
  }

  const recipeJson = JSON.stringify(recipe);
  const dirty =
    JSON.stringify(f) !== JSON.stringify(initial) || recipeJson !== recipeInitial || pendingPhoto !== null;
  function close() {
    if (dirty && !window.confirm('Discard your changes to this product?')) return;
    onClose();
  }
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.saveConfig('product', {
        id: productId ?? undefined,
        name: f.name.trim(),
        description: f.description.trim() || null,
        categoryId: f.categoryId,
        basePrice: Math.round(Number(f.price || 0) * 100),
        kitchenName: f.kitchenName.trim() || null,
        taxRateIds: f.taxRateIds,
        modifierGroupIds: f.modifierGroupIds,
        isActive: f.isActive,
      });
      // From here on the product exists: a retry updates it instead of creating another one.
      setProductId(id);
      if (pendingPhoto) {
        await api.setProductImage(id, pendingPhoto);
        if (pendingThumb) await api.setProductImageThumb(id, pendingThumb).catch(() => undefined);
        setPendingPhoto(null);
        setPendingThumb(null);
      }
      if (canRecipe && recipeJson !== recipeInitial) {
        await api.saveRecipe(id, {
          components: recipe
            .filter((r) => r.itemId && Number(r.quantity) > 0)
            .map((r) => ({ itemId: r.itemId, quantity: Number(r.quantity) })),
        });
        setRecipeInitial(recipeJson);
      }
      if (f.available !== available || (!product && !f.available)) {
        await api.saveConfig('branchProduct', { branchId, productId: id, isAvailable: f.available });
      }
      onSaved(product ? `${f.name.trim()} saved` : `${f.name.trim()} added to the menu`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const unit = (id: string) => stockItems?.find((i) => i.id === id)?.unit ?? '';
  return (
    <Drawer
      title={product ? `Edit ${str(product.name)}` : 'New product'}
      onClose={close}
      footer={
        <>
          {dirty ? <span className="small muted grow">Unsaved changes</span> : <span className="grow" />}
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="product-form" className="btn primary" disabled={busy}>
            {busy ? 'Saving…' : product ? 'Save product' : 'Add product'}
          </button>
        </>
      }
    >
      <form id="product-form" onSubmit={submit}>
        <FormSection
          title="Basic information"
          description="What staff see on the POS and customers see on receipts."
        >
          <Field label="Name" required>
            <input
              required
              maxLength={80}
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
              placeholder="e.g. Chicken Rice"
            />
          </Field>
          <Field label="Description" hint={`${f.description.length}/300 · optional`}>
            <textarea
              rows={2}
              maxLength={300}
              value={f.description}
              onChange={(e) => setF({ ...f, description: e.target.value })}
              placeholder="e.g. Fried rice with grilled chicken and shito"
            />
          </Field>
          <Field label="Category" required>
            <select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
              {categories.map((c) => (
                <option key={str(c.id)} value={str(c.id)}>
                  {str(c.name)}
                </option>
              ))}
            </select>
          </Field>
        </FormSection>

        <FormSection
          title="Price & availability"
          description="The normal selling price. Orders keep the price they were taken at."
        >
          <Field label={`Selling price (${currency})`} required>
            <input
              required
              type="number"
              min="0"
              step="0.01"
              value={f.price}
              onChange={(e) => setF({ ...f, price: e.target.value })}
            />
          </Field>
          <fieldset>
            <legend>Availability at this branch</legend>
            <div className="seg">
              <button
                type="button"
                aria-pressed={f.available}
                className={f.available ? 'on' : ''}
                onClick={() => setF({ ...f, available: true })}
              >
                On sale
              </button>
              <button
                type="button"
                aria-pressed={!f.available}
                className={!f.available ? 'on' : ''}
                onClick={() => setF({ ...f, available: false })}
              >
                Sold out
              </button>
            </div>
            <span className="small muted">
              Sold out products cannot be added on the POS. Low ingredients only show a warning; they never
              stop a sale.
            </span>
          </fieldset>
          {promotions ? (
            <fieldset>
              <legend>Promotions</legend>
              {affecting.length === 0 ? (
                <span className="small muted">No promotion affects this product.</span>
              ) : (
                <ul className="plain-list compact">
                  {affecting.map((p) => (
                    <li key={p.id}>
                      <Badge value={`promo_${p.phase}`} /> <strong>{p.name}</strong>
                      <div className="small muted">{p.summary}</div>
                    </li>
                  ))}
                </ul>
              )}
              <a className="small" href="/promotions" onClick={linkTo('/promotions')}>
                Manage promotions <Icon name="arrow-right" size={14} />
              </a>
            </fieldset>
          ) : null}
        </FormSection>

        <FormSection title="Photo" description="Shown on the POS buttons and in the menu list. Optional.">
          <div className="photo-field">
            <div className="photo-frame">
              {photoUrl ? (
                <img src={photoUrl} alt={f.name || 'Product photo'} />
              ) : (
                <span className="photo-empty">No photo</span>
              )}
            </div>
            <div className="photo-actions">
              <div className="row">
                <label className={`btn sm ${photo.kind === 'working' ? 'disabled' : ''}`}>
                  <input
                    type="file"
                    accept={ACCEPTED.join(',')}
                    hidden
                    disabled={photo.kind === 'working'}
                    onChange={(e) => {
                      void choosePhoto(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                  {photoUrl ? 'Change photo' : 'Add photo'}
                </label>
                {photoUrl ? (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={photo.kind === 'working'}
                    onClick={() => void removePhoto()}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              {photo.kind === 'working' ? (
                <span className="small muted" role="status">
                  {photo.label}
                </span>
              ) : photo.kind === 'done' ? (
                <span className="small ok-text" role="status">
                  <Icon name="check" size={16} /> {photo.label}
                </span>
              ) : photo.kind === 'error' ? (
                <span className="field-error" role="alert">
                  {photo.message}
                </span>
              ) : null}
              <details className="photo-tips">
                <summary>Tips for a good photo</summary>
                <ul>
                  <li>Clear and well lit (daylight works best)</li>
                  <li>The dish centred and filling most of the frame</li>
                  <li>Square or landscape, little background clutter</li>
                  <li>A phone photo is fine. JPEG, PNG or WebP; it is resized automatically</li>
                </ul>
              </details>
            </div>
          </div>
        </FormSection>

        {canRecipe ? (
          <FormSection
            title="Recipe"
            description="What ONE portion uses. Sending an order to the kitchen takes these quantities out of stock. Promotions never change it."
          >
            {!stockItems ? (
              <span className="small muted">Loading stock items…</span>
            ) : stockItems.length === 0 ? (
              <span className="small muted">
                No stock items yet.{' '}
                <a href="/inventory" onClick={linkTo('/inventory')}>
                  Add ingredients in Stock
                </a>{' '}
                first; products without a recipe do not change stock.
              </span>
            ) : (
              <>
                {recipe.map((r, n) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: editable rows
                  <div key={n} className="form-row recipe-row">
                    <select
                      aria-label="Ingredient"
                      value={r.itemId}
                      onChange={(e) =>
                        setRecipe(recipe.map((x, i) => (i === n ? { ...x, itemId: e.target.value } : x)))
                      }
                    >
                      <option value="">Choose ingredient</option>
                      {stockItems.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name} ({i.unit})
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label="Quantity per portion"
                      type="number"
                      min="0.001"
                      step="0.001"
                      placeholder={`quantity ${unit(r.itemId)}`}
                      value={r.quantity}
                      onChange={(e) =>
                        setRecipe(recipe.map((x, i) => (i === n ? { ...x, quantity: e.target.value } : x)))
                      }
                    />
                    <button
                      type="button"
                      className="btn"
                      aria-label="Remove ingredient"
                      onClick={() => setRecipe(recipe.filter((_, i) => i !== n))}
                    >
                      <Icon name="close" size={18} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setRecipe([...recipe, { itemId: '', quantity: '' }])}
                >
                  + Add ingredient
                </button>
              </>
            )}
          </FormSection>
        ) : null}

        <FormSection title="Kitchen" description="Where it is prepared and what the kitchen sees.">
          <Field label="Name on kitchen tickets" hint="Optional. Short and clear, e.g. JOLLOF">
            <input
              maxLength={40}
              value={f.kitchenName}
              onChange={(e) => setF({ ...f, kitchenName: e.target.value })}
            />
          </Field>
          {route ? (
            <div className="small">
              Goes to{' '}
              {route.stationId ? (
                <strong>{route.stationName}</strong>
              ) : (
                <span className="pill danger">no station</span>
              )}{' '}
              <span className="muted">
                ({route.because}
                {route.outputs.length ? ` · ${route.outputs.join(', ')}` : ''})
              </span>
              {' · '}
              <a href="/routing" onClick={linkTo('/routing')}>
                Stations & routing
              </a>
            </div>
          ) : null}
          <fieldset>
            <legend>Extras and options</legend>
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
          {product ? (
            <label className="check">
              <input
                type="checkbox"
                checked={f.isActive}
                onChange={(e) => setF({ ...f, isActive: e.target.checked })}
              />
              On the menu (untick to hide it everywhere without deleting its history)
            </label>
          ) : null}
        </FormSection>
        {error ? (
          <Alert tone="danger">
            {productId && !product ? 'The product was added, but not everything was saved: ' : ''}
            {errorMessage(error)}
          </Alert>
        ) : null}
      </form>
    </Drawer>
  );
}
