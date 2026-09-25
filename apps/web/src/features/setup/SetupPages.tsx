import type { ConfigEntity, ConfigurationView, MeView } from '@rp/contracts';
import { type FormEvent, useMemo, useState } from 'react';
import { explainRoute, routingFrom } from '../../infra/routing';
import { hasPermission } from '../../infra/session';
import { ErrorBox } from '../../ui/components';
import { Empty, Shell, Skeleton } from '../../ui/Shell';
import { DevicesTab, FloorTab, PrintQueueTab, StaffTab, StationsTab } from '../admin/AdminScreen';
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

const PERMISSION_LABEL: [string, string][] = [
  ['order.create', 'Take orders'],
  ['order.send', 'Send to kitchen'],
  ['order.view', 'See orders'],
  ['order.fulfil', 'Serve / hand over'],
  ['order.cancel', 'Cancel orders'],
  ['order.void', 'Void items'],
  ['payment.record', 'Take payments'],
  ['payment.void', 'Void payments'],
  ['payment.refund', 'Refund'],
  ['receipt.print', 'Print receipts'],
  ['kitchen.operate', 'Kitchen screen'],
  ['reports.view', 'Dashboard & reports'],
  ['inventory.manage', 'Manage stock'],
  ['stock.count', 'Count stock'],
  ['menu.manage', 'Edit menu & routing'],
  ['config.manage', 'Floor & settings'],
  ['device.manage', 'Devices'],
  ['print.manage', 'Print queue'],
  ['staff.manage', 'Staff & roles'],
  ['audit.view', 'Audit history'],
];

export function StaffPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const { config, error, setError, reload } = useSetup();
  const roles = (config?.roles ?? []).filter(
    (r) => !['Kitchen display', 'Customer display'].includes(r.name),
  );
  return (
    <Shell
      me={me}
      title="Staff & roles"
      subtitle="Who can sign in, and what each role is allowed to do. The server checks every action."
    >
      <ErrorBox error={error} />
      {!config ? (
        <Skeleton rows={6} />
      ) : (
        <>
          <StaffTab config={config} branchId={branchId} reload={reload} onError={setError} />
          <section className="card">
            <div className="card-head">
              <h2>What each role can do</h2>
            </div>
            <div className="table-scroll">
              <table className="list matrix">
                <thead>
                  <tr>
                    <th />
                    {roles.map((r) => (
                      <th key={r.id}>{r.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PERMISSION_LABEL.map(([code, label]) => (
                    <tr key={code}>
                      <td>{label}</td>
                      {roles.map((r) => (
                        <td key={r.id} className="center">
                          {r.permissions.includes(code) ? (
                            <span className="yes">✓</span>
                          ) : (
                            <span className="no">·</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
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

export function SettingsPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const { config, error, save } = useSetup();
  const branch = (config?.branches as Row[] | undefined)?.find((b) => b.id === branchId);
  return (
    <Shell me={me} title="Settings" subtitle="Restaurant details and how the business day works.">
      <ErrorBox error={error} />
      {!config || !branch ? (
        <Skeleton rows={6} />
      ) : (
        <BranchForm config={config} branch={branch} save={save} />
      )}
    </Shell>
  );
}

function BranchForm({
  config,
  branch,
  save,
}: {
  config: ConfigurationView;
  branch: Row;
  save: (e: ConfigEntity, r: Row) => Promise<string | null>;
}) {
  const [f, setF] = useState({
    name: str(branch.name),
    address: str(branch.address),
    timezone: str(branch.timezone),
    businessDayCutoff: str(branch.businessDayCutoff),
  });
  const [saved, setSaved] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (
      await save('branch', {
        id: branch.id,
        name: f.name,
        address: f.address || null,
        timezone: f.timezone,
        businessDayCutoff: f.businessDayCutoff,
      })
    )
      setSaved(true);
  }
  return (
    <div className="grid-2">
      <section className="card">
        <div className="card-head">
          <h2>Restaurant</h2>
        </div>
        <dl className="facts">
          <dt>Name</dt>
          <dd>{config.restaurant.name}</dd>
          <dt>Currency</dt>
          <dd>{config.restaurant.currency}</dd>
          <dt>Order numbers</dt>
          <dd>Start at {str(branch.orderNumberStart)} every business day, shared by all tills</dd>
        </dl>
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Branch</h2>
        </div>
        <form className="form" onSubmit={submit}>
          <label>
            Branch name
            <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label>
            Address (printed on receipts)
            <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
          </label>
          <div className="form-row">
            <label>
              Time zone
              <input value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} />
            </label>
            <label>
              Business day ends at
              <input
                type="time"
                value={f.businessDayCutoff}
                onChange={(e) => setF({ ...f, businessDayCutoff: e.target.value })}
              />
            </label>
          </div>
          <div className="small muted">
            Orders after midnight but before this time count towards the previous day (late service).
          </div>
          <div className="row end">
            {saved ? <span className="small ok-text">Saved</span> : null}
            <button type="submit" className="btn primary">
              Save settings
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
