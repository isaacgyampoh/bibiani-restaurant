import type { ConfigEntity, ConfigurationView, MeView, PairingCodeView } from '@rp/contracts';
import { DEVICE_KINDS, PAYMENT_POLICIES } from '@rp/domain';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { linkTo } from '../../infra/router';
import { api, signOut, topics } from '../../infra/session';
import { useFeed } from '../../infra/use-feed';
import { Badge, ConnectionDot, ErrorBox, Modal, Money } from '../../ui/components';

type Tab = 'devices' | 'menu' | 'stations' | 'floor' | 'staff' | 'print';
type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/**
 * Enough administration to configure a working restaurant. Every save goes
 * through the API (validated, permission-checked, audited); nothing here
 * writes to the database directly.
 */
export function AdminScreen({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const [tab, setTab] = useState<Tab>('devices');
  const [config, setConfig] = useState<ConfigurationView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(() => {
    api.configuration().then(setConfig).catch(setError);
  }, []);
  useEffect(reload, [reload]);

  async function save(entity: ConfigEntity, record: Row) {
    setError(null);
    try {
      await api.saveConfig(entity, record);
      reload();
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  }

  const tabs: [Tab, string][] = [
    ['devices', 'Devices'],
    ['menu', 'Menu'],
    ['stations', 'Stations & routing'],
    ['floor', 'Areas & tables'],
    ['staff', 'Staff'],
    ['print', 'Print queue'],
  ];
  return (
    <div className="app">
      <div className="topbar">
        <span className="title">Admin · {me.restaurant.name}</span>
        <div className="tabs">
          {tabs.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`tab ${tab === k ? 'active' : ''}`}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <a href="/pos" onClick={linkTo('/pos')}>
          POS
        </a>
        <button type="button" className="link" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
      <div className="page">
        <ErrorBox error={error} />
        {!config ? <div className="muted">Loading…</div> : null}
        {config && tab === 'devices' ? (
          <DevicesTab branchId={branchId} config={config} save={save} onError={setError} />
        ) : null}
        {config && tab === 'menu' ? <MenuTab config={config} branchId={branchId} save={save} /> : null}
        {config && tab === 'stations' ? (
          <StationsTab config={config} branchId={branchId} save={save} reload={reload} onError={setError} />
        ) : null}
        {config && tab === 'floor' ? <FloorTab config={config} branchId={branchId} save={save} /> : null}
        {config && tab === 'staff' ? (
          <StaffTab config={config} branchId={branchId} reload={reload} onError={setError} />
        ) : null}
        {tab === 'print' ? <PrintQueueTab branchId={branchId} /> : null}
      </div>
    </div>
  );
}

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="panel">
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 className="grow" style={{ margin: 0 }}>
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Small inline form: fields are [key, label, type, options?]. */
function QuickForm({
  fields,
  onSubmit,
  submitLabel,
}: {
  fields: [string, string, 'text' | 'number' | 'money' | 'select' | 'checkbox', [string, string][]?][];
  onSubmit: (values: Row) => Promise<boolean>;
  submitLabel: string;
}) {
  const [values, setValues] = useState<Row>({});
  return (
    <form
      className="row wrap"
      style={{ alignItems: 'flex-end' }}
      onSubmit={async (e) => {
        e.preventDefault();
        const out: Row = {};
        for (const [key, , type] of fields) {
          const v = values[key];
          if (type === 'number') out[key] = v === undefined || v === '' ? undefined : Number(v);
          else if (type === 'money') out[key] = Math.round(Number.parseFloat(str(v) || '0') * 100);
          else if (type === 'checkbox') out[key] = Boolean(v);
          else out[key] = v === '' ? undefined : v;
        }
        if (await onSubmit(out)) setValues({});
      }}
    >
      {fields.map(([key, label, type, options]) => {
        const set = (value: unknown) => setValues((s) => ({ ...s, [key]: value }));
        if (type === 'checkbox') {
          return (
            <label key={key} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <input type="checkbox" checked={Boolean(values[key])} onChange={(e) => set(e.target.checked)} />
              {label}
            </label>
          );
        }
        if (type === 'select') {
          return (
            <label key={key}>
              {label}
              <select value={str(values[key])} onChange={(e) => set(e.target.value)}>
                <option value="">—</option>
                {options?.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        return (
          <label key={key}>
            {label}
            <input
              value={str(values[key])}
              inputMode={type === 'text' ? undefined : 'decimal'}
              onChange={(e) => set(e.target.value)}
            />
          </label>
        );
      })}
      <button type="submit" className="btn primary">
        {submitLabel}
      </button>
    </form>
  );
}

function DevicesTab({
  branchId,
  config,
  save,
  onError,
}: {
  branchId: string;
  config: ConfigurationView;
  save: (e: ConfigEntity, r: Row) => Promise<boolean>;
  onError: (e: unknown) => void;
}) {
  const feed = useFeed(`ops:${branchId}`, () => api.operations(branchId), {
    topic: topics.ops(branchId),
    pollMs: 20_000,
  });
  const [pairing, setPairing] = useState<(PairingCodeView & { name: string }) | null>(null);
  const stations = config.stations.filter((s) => s.branchId === branchId) as Row[];
  const agents = config.devices.filter((d) => d.kind === 'print_agent') as Row[];
  const printers = config.devices.filter((d) => d.kind === 'printer') as Row[];
  return (
    <>
      <Section
        title="Device status (from heartbeats and printer reports)"
        actions={<ConnectionDot state={feed.connection} />}
      >
        <table className="list">
          <thead>
            <tr>
              <th>Device</th>
              <th>Type</th>
              <th>Status</th>
              <th>Last seen</th>
              <th>Details</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {feed.data?.devices.map((d) => (
              <tr key={d.id}>
                <td>
                  <strong>{d.name}</strong>
                  {!d.isActive ? <span className="muted"> (inactive)</span> : null}
                </td>
                <td>{d.kind.replace('_', ' ')}</td>
                <td>
                  <Badge value={d.status === 'never_seen' ? 'pending' : d.status} />
                </td>
                <td className="small">{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleTimeString() : '—'}</td>
                <td className="small">
                  {d.printer ? (
                    <>
                      {d.printer.address}{' '}
                      {d.printer.lastError ? (
                        <span className="badge failed">{d.printer.lastError}</span>
                      ) : null}
                      {d.printer.failedJobs + d.printer.deadJobs > 0 ? (
                        <span className="badge dead">
                          {d.printer.failedJobs + d.printer.deadJobs} unprinted
                        </span>
                      ) : null}
                    </>
                  ) : d.kind !== 'printer' ? (
                    d.paired ? (
                      'paired'
                    ) : (
                      'not paired'
                    )
                  ) : null}
                </td>
                <td className="row">
                  {['pos', 'kds', 'customer_display', 'print_agent'].includes(d.kind) ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        void api
                          .pairingCode(d.id)
                          .then((p) => setPairing({ ...p, name: d.name }))
                          .catch(onError)
                      }
                    >
                      Pairing code
                    </button>
                  ) : null}
                  {d.paired ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void api.revokeDevice(d.id).then(feed.refresh).catch(onError)}
                    >
                      Revoke
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Add device">
        <QuickForm
          submitLabel="Add device"
          fields={[
            ['name', 'Name (e.g. PASTRY-KDS-01)', 'text'],
            ['kind', 'Type', 'select', DEVICE_KINDS.map((k) => [k, k.replace('_', ' ')])],
            ['stationId', 'Station (KDS)', 'select', stations.map((s) => [str(s.id), str(s.name)])],
            ['address', 'Printer address (IP:9100)', 'text'],
            [
              'agentDeviceId',
              'Printer driven by agent',
              'select',
              agents.map((a) => [str(a.id), str(a.name)]),
            ],
            [
              'receiptPrinterId',
              'Receipt printer (POS)',
              'select',
              printers.map((p) => [str(p.id), str(p.name)]),
            ],
          ]}
          onSubmit={(v) =>
            save('device', {
              branchId,
              kind: v.kind,
              name: v.name,
              stationId: v.stationId ?? null,
              receiptPrinterId: v.receiptPrinterId ?? null,
              printer:
                v.kind === 'printer' ? { address: v.address, agentDeviceId: v.agentDeviceId ?? null } : null,
            }).then((ok) => {
              if (ok) feed.refresh();
              return ok;
            })
          }
        />
      </Section>
      {pairing ? (
        <Modal title={`Pair ${pairing.name}`} onClose={() => setPairing(null)}>
          <p>
            On the device, open <strong>{location.origin}/pair</strong> and enter:
          </p>
          <div style={{ fontSize: 48, fontWeight: 900, letterSpacing: '0.2em', textAlign: 'center' }}>
            {pairing.code}
          </div>
          <p className="muted">Single use. Expires at {new Date(pairing.expiresAt).toLocaleTimeString()}.</p>
        </Modal>
      ) : null}
    </>
  );
}

function MenuTab({
  config,
  branchId,
  save,
}: {
  config: ConfigurationView;
  branchId: string;
  save: (e: ConfigEntity, r: Row) => Promise<boolean>;
}) {
  const cats = config.categories as Row[];
  const taxes = config.taxRates as Row[];
  const catName = (id: unknown) => str(cats.find((c) => c.id === id)?.name);
  return (
    <>
      <Section title="Categories">
        <div className="row wrap">
          {cats.map((c) => (
            <span key={str(c.id)} className="badge">
              {str(c.name)}
              {c.parentId ? ` ← ${catName(c.parentId)}` : ''}
            </span>
          ))}
        </div>
        <QuickForm
          submitLabel="Add category"
          fields={[
            ['name', 'Name', 'text'],
            ['parentId', 'Parent', 'select', cats.map((c) => [str(c.id), str(c.name)])],
          ]}
          onSubmit={(v) => save('category', { name: v.name, parentId: v.parentId ?? null })}
        />
      </Section>
      <Section title="Products">
        <table className="list">
          <thead>
            <tr>
              <th>Product</th>
              <th>Category</th>
              <th>Price</th>
              <th>Active</th>
              <th>Available here</th>
            </tr>
          </thead>
          <tbody>
            {(config.products as Row[]).map((p) => (
              <tr key={str(p.id)}>
                <td>{str(p.name)}</td>
                <td>{catName(p.categoryId)}</td>
                <td>
                  <PriceEditor product={p} save={save} currency={config.restaurant.currency} />
                </td>
                <td>{p.isActive ? 'yes' : 'no'}</td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void save('branchProduct', { branchId, productId: p.id, isAvailable: false })
                    }
                  >
                    Sold out
                  </button>{' '}
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void save('branchProduct', { branchId, productId: p.id, isAvailable: true })
                    }
                  >
                    Available
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <QuickForm
          submitLabel="Add product"
          fields={[
            ['name', 'Name', 'text'],
            ['categoryId', 'Category', 'select', cats.map((c) => [str(c.id), str(c.name)])],
            ['basePrice', 'Price', 'money'],
            ['kitchenName', 'Kitchen name', 'text'],
            [
              'taxRateId',
              'Tax',
              'select',
              taxes.map((t) => [str(t.id), `${str(t.name)} ${Number(t.rateBp) / 100}%`]),
            ],
          ]}
          onSubmit={(v) =>
            save('product', {
              name: v.name,
              categoryId: v.categoryId,
              basePrice: v.basePrice,
              kitchenName: v.kitchenName ?? null,
              taxRateIds: v.taxRateId ? [v.taxRateId] : [],
            })
          }
        />
      </Section>
      <Section title="Taxes (configured, never hard-coded)">
        <div className="row wrap">
          {taxes.map((t) => (
            <span key={str(t.id)} className="badge">
              {str(t.name)} {Number(t.rateBp) / 100}% {t.isInclusive ? 'incl.' : 'added'}
            </span>
          ))}
        </div>
        <QuickForm
          submitLabel="Add tax"
          fields={[
            ['name', 'Name', 'text'],
            ['rateBp', 'Rate (basis points, 1500 = 15%)', 'number'],
            ['isInclusive', 'Included in prices', 'checkbox'],
          ]}
          onSubmit={(v) => save('taxRate', { name: v.name, rateBp: v.rateBp, isInclusive: v.isInclusive })}
        />
      </Section>
    </>
  );
}

function PriceEditor({
  product,
  save,
  currency,
}: {
  product: Row;
  save: (e: ConfigEntity, r: Row) => Promise<boolean>;
  currency: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState((Number(product.basePrice) / 100).toFixed(2));
  if (!editing)
    return (
      <button type="button" className="btn" onClick={() => setEditing(true)}>
        <Money minor={Number(product.basePrice)} currency={currency} />
      </button>
    );
  return (
    <span className="row">
      <input style={{ width: 100 }} value={value} onChange={(e) => setValue(e.target.value)} />
      <button
        type="button"
        className="btn primary"
        onClick={() =>
          void save('product', {
            id: product.id,
            categoryId: product.categoryId,
            name: product.name,
            kitchenName: product.kitchenName ?? null,
            basePrice: Math.round(Number.parseFloat(value) * 100),
            requiresPreparation: product.requiresPreparation,
            isActive: product.isActive,
            taxRateIds: product.taxRateIds,
          }).then((ok) => ok && setEditing(false))
        }
      >
        Save
      </button>
    </span>
  );
}

function StationsTab({
  config,
  branchId,
  save,
  reload,
  onError,
}: {
  config: ConfigurationView;
  branchId: string;
  save: (e: ConfigEntity, r: Row) => Promise<boolean>;
  reload: () => void;
  onError: (e: unknown) => void;
}) {
  const stations = (config.stations as Row[]).filter((s) => s.branchId === branchId);
  const devices = config.devices as Row[];
  const name = (list: Row[], id: unknown) => str(list.find((x) => x.id === id)?.name) || '—';
  const cats = config.categories as Row[];
  const products = config.products as Row[];
  return (
    <>
      <Section title="Stations and what they feed">
        <table className="list">
          <thead>
            <tr>
              <th>Station</th>
              <th>Code</th>
              <th>Outputs</th>
            </tr>
          </thead>
          <tbody>
            {stations.map((s) => (
              <tr key={str(s.id)}>
                <td>
                  <strong>{str(s.name)}</strong>
                </td>
                <td>{str(s.code)}</td>
                <td className="row wrap">
                  {(config.stationOutputs as Row[])
                    .filter((o) => o.stationId === s.id)
                    .map((o) => (
                      <span key={str(o.id)} className="badge">
                        {name(devices, o.deviceId)} · {str(o.role)}
                        <button
                          type="button"
                          className="link"
                          aria-label="Remove"
                          onClick={() =>
                            void api.deleteConfig('stationOutput', str(o.id)).then(reload).catch(onError)
                          }
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <QuickForm
          submitLabel="Add station"
          fields={[
            ['name', 'Name', 'text'],
            ['code', 'Code (e.g. GRL)', 'text'],
          ]}
          onSubmit={(v) => save('station', { branchId, name: v.name, code: str(v.code).toUpperCase() })}
        />
        <QuickForm
          submitLabel="Connect output"
          fields={[
            ['stationId', 'Station', 'select', stations.map((s) => [str(s.id), str(s.name)])],
            [
              'deviceId',
              'Printer or KDS',
              'select',
              devices
                .filter((d) => d.kind === 'printer' || d.kind === 'kds')
                .map((d) => [str(d.id), str(d.name)]),
            ],
            [
              'role',
              'Role',
              'select',
              [
                ['primary', 'primary'],
                ['copy', 'copy'],
                ['backup', 'backup'],
              ],
            ],
          ]}
          onSubmit={(v) =>
            save('stationOutput', { stationId: v.stationId, deviceId: v.deviceId, role: v.role ?? 'primary' })
          }
        />
      </Section>
      <Section title="Routing rules (product > category > default)">
        <table className="list">
          <thead>
            <tr>
              <th>Match</th>
              <th>What</th>
              <th>Station</th>
              <th>Priority</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(config.routingRules as Row[])
              .filter((r) => r.branchId === branchId)
              .map((r) => (
                <tr key={str(r.id)}>
                  <td>{str(r.match)}</td>
                  <td>
                    {r.productId
                      ? name(products, r.productId)
                      : r.categoryId
                        ? name(cats, r.categoryId)
                        : 'everything else'}
                  </td>
                  <td>{name(stations, r.stationId)}</td>
                  <td>{str(r.priority)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        void api.deleteConfig('routingRule', str(r.id)).then(reload).catch(onError)
                      }
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <QuickForm
          submitLabel="Add rule"
          fields={[
            [
              'match',
              'Match',
              'select',
              [
                ['category', 'category'],
                ['product', 'product'],
                ['default', 'default'],
              ],
            ],
            ['categoryId', 'Category', 'select', cats.map((c) => [str(c.id), str(c.name)])],
            ['productId', 'Product', 'select', products.map((p) => [str(p.id), str(p.name)])],
            ['stationId', 'Station', 'select', stations.map((s) => [str(s.id), str(s.name)])],
          ]}
          onSubmit={(v) =>
            save('routingRule', {
              branchId,
              match: v.match,
              stationId: v.stationId,
              categoryId: v.match === 'category' ? v.categoryId : null,
              productId: v.match === 'product' ? v.productId : null,
            })
          }
        />
      </Section>
    </>
  );
}

function FloorTab({
  config,
  branchId,
  save,
}: {
  config: ConfigurationView;
  branchId: string;
  save: (e: ConfigEntity, r: Row) => Promise<boolean>;
}) {
  const areas = (config.areas as Row[]).filter((a) => a.branchId === branchId);
  return (
    <>
      <Section title="Operational areas and payment policy">
        <table className="list">
          <thead>
            <tr>
              <th>Area</th>
              <th>Channel</th>
              <th>Payment policy</th>
              <th>Pay before cooking</th>
            </tr>
          </thead>
          <tbody>
            {areas.map((a) => (
              <tr key={str(a.id)}>
                <td>{str(a.name)}</td>
                <td>{str(a.channel)}</td>
                <td>
                  <select
                    value={str(a.paymentPolicy)}
                    onChange={(e) => void save('area', { ...a, paymentPolicy: e.target.value })}
                  >
                    {PAYMENT_POLICIES.map((p) => (
                      <option key={p} value={p}>
                        {p.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={Boolean(a.requirePaymentBeforeProduction)}
                    onChange={(e) =>
                      void save('area', { ...a, requirePaymentBeforeProduction: e.target.checked })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <QuickForm
          submitLabel="Add area"
          fields={[
            ['name', 'Name', 'text'],
            [
              'channel',
              'Channel',
              'select',
              [
                ['dine_in', 'dine in'],
                ['takeaway', 'takeaway'],
              ],
            ],
          ]}
          onSubmit={(v) =>
            save('area', {
              branchId,
              name: v.name,
              channel: v.channel,
              requiresTable: v.channel === 'dine_in',
            })
          }
        />
      </Section>
      <Section title="Tables">
        <div className="row wrap">
          {(config.tables as Row[])
            .filter((t) => t.branchId === branchId)
            .map((t) => (
              <span key={str(t.id)} className="badge">
                T{str(t.label)} · {str(t.capacity)}
              </span>
            ))}
        </div>
        <QuickForm
          submitLabel="Add table"
          fields={[
            ['label', 'Label', 'text'],
            ['capacity', 'Seats', 'number'],
            [
              'areaId',
              'Area',
              'select',
              areas.filter((a) => a.requiresTable).map((a) => [str(a.id), str(a.name)]),
            ],
          ]}
          onSubmit={(v) =>
            save('table', { branchId, areaId: v.areaId, label: v.label, capacity: v.capacity ?? 4 })
          }
        />
      </Section>
    </>
  );
}

function StaffTab({
  config,
  branchId,
  reload,
  onError,
}: {
  config: ConfigurationView;
  branchId: string;
  reload: () => void;
  onError: (e: unknown) => void;
}) {
  const roleName = (id: string) => config.roles.find((r) => r.id === id)?.name ?? id;
  return (
    <Section title="Staff">
      <table className="list">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Roles</th>
            <th>Active</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {config.staff.map((s) => (
            <tr key={s.id}>
              <td>{s.displayName}</td>
              <td>{s.email ?? '—'}</td>
              <td>{s.roleIds.map(roleName).join(', ')}</td>
              <td>{s.isActive ? 'yes' : <span className="badge dead">inactive</span>}</td>
              <td>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void api.updateStaff(s.id, { isActive: !s.isActive }).then(reload).catch(onError)
                  }
                >
                  {s.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <QuickForm
        submitLabel="Add staff member"
        fields={[
          ['displayName', 'Name', 'text'],
          ['email', 'Email', 'text'],
          ['password', 'Temporary password (10+ chars)', 'text'],
          ['roleId', 'Role', 'select', config.roles.map((r) => [r.id, r.name])],
        ]}
        onSubmit={(v) =>
          api
            .createStaff({
              displayName: str(v.displayName),
              email: str(v.email),
              password: str(v.password),
              roleIds: [str(v.roleId)],
              branchId,
            })
            .then(() => {
              reload();
              return true;
            })
            .catch((e) => {
              onError(e);
              return false;
            })
        }
      />
    </Section>
  );
}

function PrintQueueTab({ branchId }: { branchId: string }) {
  const feed = useFeed(`print:${branchId}`, () => api.printQueue(branchId), {
    topic: `branch:${branchId}:print`,
    pollMs: 15_000,
  });
  return (
    <Section title="Print jobs not yet printed" actions={<ConnectionDot state={feed.connection} />}>
      <table className="list">
        <thead>
          <tr>
            <th>Order</th>
            <th>Printer</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Last error</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {feed.data?.jobs.map((j) => (
            <tr key={j.id}>
              <td>{j.orderNumber ? `#${j.orderNumber}` : '—'}</td>
              <td>{j.printerName}</td>
              <td>{j.kind.replace('_', ' ')}</td>
              <td>
                <Badge value={j.status} />
                {j.possibleDuplicate ? <span className="badge failed">possible duplicate</span> : null}
              </td>
              <td>{j.attempts}</td>
              <td className="small">{j.lastError ?? ''}</td>
              <td>
                {j.status === 'dead' || j.status === 'failed' ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void api.retryPrintJob(j.id).then(feed.refresh)}
                  >
                    Retry
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
          {feed.data?.jobs.length === 0 ? (
            <tr>
              <td colSpan={7} className="muted">
                Everything has printed.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Section>
  );
}
