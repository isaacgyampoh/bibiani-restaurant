import type { ConfigEntity, ConfigurationView, MeView } from '@rp/contracts';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { linkTo } from '../../infra/router';
import { explainRoute, routingFrom } from '../../infra/routing';
import { hasPermission } from '../../infra/session';
import { ErrorBox, Field, FormSection, useToast } from '../../ui/components';
import { Empty, Shell, Skeleton } from '../../ui/Shell';
import { DevicesTab, FloorTab, PrintQueueTab, StationsTab } from '../admin/AdminScreen';
import { useConfiguration } from '../menu/MenuPage';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function useSetup() {
  const c = useConfiguration();
  const saveBool = (e: ConfigEntity, r: Row) => c.save(e, r).then(Boolean);
  return { ...c, saveBool };
}

/** Product/category → station → screens and printers, computed exactly as the server routes orders. */
function RouteMap({ config, branchId }: { config: ConfigurationView; branchId: string }) {
  const areas = (config.areas as Row[]).filter((a) => a.branchId === branchId && a.isActive);
  const [areaId, setAreaId] = useState(str(areas[0]?.id));
  const routing = useMemo(() => routingFrom(config), [config]);
  const products = (config.products as Row[]).filter((p) => p.isActive);
  const byStation = new Map<
    string,
    { name: string; outputs: string[]; items: { name: string; because: string }[] }
  >();
  const unrouted: string[] = [];
  for (const p of products) {
    const r = explainRoute(config, routing, { id: str(p.id), categoryId: str(p.categoryId) }, areaId);
    if (!r.stationId) {
      unrouted.push(str(p.name));
      continue;
    }
    const entry = byStation.get(r.stationId) ?? { name: r.stationName, outputs: r.outputs, items: [] };
    entry.items.push({ name: str(p.name), because: r.because });
    byStation.set(r.stationId, entry);
  }
  return (
    <section className="card">
      <div className="card-head">
        <h2>Where each item goes</h2>
        <div className="seg light">
          {areas.map((a) => (
            <button
              key={str(a.id)}
              type="button"
              className={areaId === a.id ? 'on' : ''}
              onClick={() => setAreaId(str(a.id))}
            >
              {str(a.name)}
            </button>
          ))}
        </div>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        One order can contain items for several stations: each station receives only its own items on its
        screen or printer, and the customer still sees one order number.
      </p>
      {unrouted.length ? (
        <div className="info-box danger">
          Not routed (no station would receive them): <strong>{unrouted.join(', ')}</strong>. Add a default
          rule or a category rule below.
        </div>
      ) : null}
      {byStation.size === 0 ? (
        <Empty title="No routing yet">
          Create stations, give each a screen or printer, then add routing rules.
        </Empty>
      ) : (
        <div className="route-map">
          {[...byStation.entries()].map(([id, s]) => (
            <div key={id} className="route-station">
              <div className="route-head">
                <strong>{s.name}</strong>
                <span className="small muted">{s.items.length} item(s)</span>
              </div>
              <div className="route-outputs">
                {s.outputs.map((o) => (
                  <span key={o} className="chip">
                    {o}
                  </span>
                ))}
              </div>
              <ul>
                {s.items.map((i) => (
                  <li key={i.name}>
                    {i.name} <span className="small muted">· {i.because}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Per-station choice: show selling prices on the kitchen screen. Printed kitchen tickets never show prices. */
function StationPrices({
  config,
  branchId,
  saveBool,
}: {
  config: ConfigurationView;
  branchId: string;
  saveBool: (e: ConfigEntity, r: Row) => Promise<boolean>;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Kitchen screen settings</h2>
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Station</th>
            <th>Target time</th>
            <th>Show prices on screen</th>
          </tr>
        </thead>
        <tbody>
          {(config.stations as Row[])
            .filter((st) => st.branchId === branchId)
            .map((st) => (
              <tr key={str(st.id)}>
                <td>
                  <strong>{str(st.name)}</strong>
                </td>
                <td className="muted">
                  {st.targetPrepSeconds ? `${Math.round(Number(st.targetPrepSeconds) / 60)} min` : '—'}
                </td>
                <td>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={Boolean(st.showPrices)}
                      onChange={(e) =>
                        void saveBool('station', {
                          id: st.id,
                          branchId: st.branchId,
                          name: st.name,
                          code: st.code,
                          targetPrepSeconds: st.targetPrepSeconds ?? null,
                          autoReady: Boolean(st.autoReady),
                          isActive: Boolean(st.isActive),
                          sortOrder: Number(st.sortOrder ?? 0),
                          showPrices: e.target.checked,
                        })
                      }
                    />
                    {st.showPrices ? 'Prices shown' : 'Hidden'}
                  </label>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}

export function RoutingPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const { config, error, setError, reload, saveBool } = useSetup();
  return (
    <Shell
      me={me}
      title="Stations & routing"
      subtitle="Kitchen stations, their screens and printers, and which items each one prepares."
    >
      <ErrorBox error={error} />
      {!config ? (
        <Skeleton rows={8} />
      ) : (
        <>
          <RouteMap config={config} branchId={branchId} />
          <StationPrices config={config} branchId={branchId} saveBool={saveBool} />
          <StationsTab
            config={config}
            branchId={branchId}
            save={saveBool}
            reload={reload}
            onError={setError}
          />
        </>
      )}
    </Shell>
  );
}

export function FloorPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const { config, error, saveBool } = useSetup();
  return (
    <Shell me={me} title="Floor & tables" subtitle="Service areas, their payment rule, and tables.">
      <ErrorBox error={error} />
      {!config ? <Skeleton rows={6} /> : <FloorTab config={config} branchId={branchId} save={saveBool} />}
    </Shell>
  );
}

export function DevicesPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const { config, error, setError, saveBool } = useSetup();
  return (
    <Shell
      me={me}
      title="Devices & printing"
      subtitle="Tills, kitchen screens, customer display and printers. Hardware can be connected at any time."
    >
      <ErrorBox error={error} />
      {!config ? (
        <Skeleton rows={6} />
      ) : (
        <>
          {hasPermission(me, 'device.manage') ? (
            <DevicesTab branchId={branchId} config={config} save={saveBool} onError={setError} />
          ) : null}
          {hasPermission(me, 'print.manage') ? <PrintQueueTab branchId={branchId} /> : null}
        </>
      )}
    </Shell>
  );
}

const SETTINGS_GROUPS = [
  ['restaurant', 'Restaurant'],
  ['pos', 'POS'],
  ['kitchen', 'Kitchen'],
  ['inventory', 'Inventory'],
  ['staff', 'Staff'],
  ['promotions', 'Promotions'],
] as const;
type SettingsGroup = (typeof SETTINGS_GROUPS)[number][0];

export function SettingsPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const { config, error, save, saveBool } = useSetup();
  const branch = (config?.branches as Row[] | undefined)?.find((b) => b.id === branchId);
  const [group, setGroup] = useState<SettingsGroup>(() => {
    const h = window.location.hash.slice(1);
    return (SETTINGS_GROUPS.find(([k]) => k === h)?.[0] ?? 'restaurant') as SettingsGroup;
  });
  const [dirty, setDirty] = useState(false);
  function choose(g: SettingsGroup) {
    if (dirty && !window.confirm('You have unsaved restaurant settings. Leave without saving?')) return;
    setDirty(false);
    setGroup(g);
    window.history.replaceState(null, '', `#${g}`);
  }
  const link = (href: string, label: string) => (
    <a className="btn" href={href} onClick={linkTo(href)}>
      {label}
    </a>
  );
  return (
    <Shell me={me} title="Settings" subtitle="Everything that shapes how the restaurant runs, in one place.">
      <ErrorBox error={error} />
      <div className="tabs-line" role="tablist" aria-label="Settings groups">
        {SETTINGS_GROUPS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={group === k}
            className={group === k ? 'on' : ''}
            onClick={() => choose(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {!config || !branch ? (
        <Skeleton rows={6} />
      ) : group === 'restaurant' ? (
        <BranchForm config={config} branch={branch} save={save} onDirty={setDirty} />
      ) : group === 'kitchen' ? (
        <>
          <StationPrices config={config} branchId={branchId} saveBool={saveBool} />
          <section className="card">
            <div className="card-body small muted">
              Kitchen screens show quantity × unit price, any promotion, and the line and ticket totals, from
              the price saved on the order. Printed kitchen tickets are production tickets and never show
              prices. {link('/routing', 'Stations, screens & routing')}
            </div>
          </section>
        </>
      ) : (
        <section className="card">
          <div className="card-body settings-summary">
            {group === 'pos' ? (
              <>
                <p>
                  Service areas (dine-in, takeaway), tables, and whether an area is paid before or after the
                  food is served. Tills lock themselves after a few idle minutes; staff unlock them with their
                  own PIN.
                </p>
                <div className="row">
                  {link('/floor', 'Floor, areas & tables')}
                  {link('/devices', 'Tills, screens & printers')}
                </div>
              </>
            ) : group === 'inventory' ? (
              <>
                <p>
                  Stock items with a minimum level (Low stock at or below it, Out of stock at zero), recipes
                  that deduct stock when an order is sent to the kitchen, and stock takes with approval.
                  Promotions never change how much stock a dish uses.
                </p>
                <div className="row">
                  {link('/inventory', 'Stock items')}
                  {link('/menu', 'Recipes')}
                  {link('/stock-takes', 'Stock taking')}
                </div>
              </>
            ) : group === 'staff' ? (
              <>
                <p>
                  People, roles and PINs. PINs are unique among active staff, never shown after they are set,
                  and locked out after repeated wrong attempts. Owners and managers also use an email and
                  password for the back office.
                </p>
                <div className="row">{link('/staff', 'Staff & roles')}</div>
              </>
            ) : (
              <>
                <p>
                  Automatic promotions (percentage off, amount off, promotional price, bundles) with dates,
                  days and times. Manager discounts are separate: they need the discount permission and a
                  reason, and are recorded in the audit history.
                </p>
                <div className="row">
                  {hasPermission(me, 'promotions.manage') ? link('/promotions', 'Promotions') : null}
                </div>
              </>
            )}
          </div>
        </section>
      )}
    </Shell>
  );
}

function BranchForm({
  config,
  branch,
  save,
  onDirty,
}: {
  config: ConfigurationView;
  branch: Row;
  save: (e: ConfigEntity, r: Row) => Promise<string | null>;
  onDirty: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const [r, setR] = useState({
    name: config.restaurant.name,
    phone: config.restaurant.phone ?? '',
    receiptFooter: config.restaurant.receiptFooter ?? '',
  });
  const [f, setF] = useState({
    name: str(branch.name),
    address: str(branch.address),
    timezone: str(branch.timezone),
    businessDayCutoff: str(branch.businessDayCutoff),
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(() => JSON.stringify({ r, f }));
  const dirty = JSON.stringify({ r, f }) !== saved;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  // Unsaved-change protection when closing or reloading the tab.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const ok =
      (await save('restaurant', {
        name: r.name,
        phone: r.phone || null,
        receiptFooter: r.receiptFooter || null,
      })) &&
      (await save('branch', {
        id: branch.id,
        name: f.name,
        address: f.address || null,
        timezone: f.timezone,
        businessDayCutoff: f.businessDayCutoff,
      }));
    setBusy(false);
    if (ok) {
      setSaved(JSON.stringify({ r, f }));
      toast('Settings saved');
    }
  }
  return (
    <section className="card">
      <form className="card-body" onSubmit={submit}>
        <FormSection title="Restaurant" description="Shown on every screen and printed on receipts.">
          <Field label="Restaurant name" required>
            <input required value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} />
          </Field>
          <Field label="Phone" hint="Printed on receipts.">
            <input
              value={r.phone}
              onChange={(e) => setR({ ...r, phone: e.target.value })}
              placeholder="+233 …"
            />
          </Field>
          <Field label="Receipt message" hint="The last line of every receipt.">
            <input
              value={r.receiptFooter}
              onChange={(e) => setR({ ...r, receiptFooter: e.target.value })}
              placeholder="Thank you! Food is better than love."
            />
          </Field>
          <dl className="facts">
            <dt>Currency</dt>
            <dd>{config.restaurant.currency}</dd>
          </dl>
        </FormSection>
        <FormSection title="Branch" description="Address and how the business day works.">
          <Field label="Branch name" required>
            <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Address" hint="Printed on receipts.">
            <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
          </Field>
          <div className="form-row">
            <Field label="Time zone">
              <input value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} />
            </Field>
            <Field label="Business day ends at" hint="Orders before this time count for the previous day.">
              <input
                type="time"
                value={f.businessDayCutoff}
                onChange={(e) => setF({ ...f, businessDayCutoff: e.target.value })}
              />
            </Field>
          </div>
          <dl className="facts">
            <dt>Order numbers</dt>
            <dd>Start at {str(branch.orderNumberStart)} each business day, shared by all tills</dd>
          </dl>
        </FormSection>
        <div className="form-actions">
          {dirty ? <span className="small muted grow">Unsaved changes</span> : null}
          <button type="submit" className="btn primary" disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </section>
  );
}
