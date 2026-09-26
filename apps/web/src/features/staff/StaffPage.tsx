import { ApiError } from '@rp/client-core';
import type { ConfigurationView, MeView } from '@rp/contracts';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../../infra/session';
import {
  Badge,
  Drawer,
  ErrorBox,
  Field,
  FormSection,
  Modal,
  useGuardedClose,
  useToast,
} from '../../ui/components';
import { Icon } from '../../ui/icons';
import { Empty, initials, Shell, Skeleton } from '../../ui/Shell';

type Staff = ConfigurationView['staff'][number];
const PIN_STATE: Record<Staff['pin'], [string, 'ok' | 'warn' | 'neutral']> = {
  active: ['PIN active', 'ok'],
  awaiting_activation: ['Awaiting first sign-in', 'warn'],
  none: ['No PIN', 'neutral'],
};
/** Roles whose people normally work in the back office, so a password is worth setting. */
const BACK_OFFICE = new Set(['Owner', 'Manager', 'Inventory Manager']);

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
  ['menu.manage', 'Menu & routing'],
  ['config.manage', 'Floor & settings'],
  ['device.manage', 'Devices'],
  ['print.manage', 'Print queue'],
  ['staff.manage', 'Staff & roles'],
  ['audit.view', 'Audit history'],
];

export function StaffPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const [config, setConfig] = useState<ConfigurationView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Staff | 'new' | null>(null);
  const [resetting, setResetting] = useState<Staff | null>(null);
  const [confirming, setConfirming] = useState<Staff | null>(null);
  const [tab, setTab] = useState<'active' | 'inactive' | 'roles'>('active');
  const toast = useToast();
  const reload = useCallback(() => {
    api.configuration().then(setConfig).catch(setError);
  }, []);
  useEffect(reload, [reload]);
  const roleName = (id: string) => config?.roles.find((r) => r.id === id)?.name ?? '';
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const people = (config?.staff ?? [])
    .filter((s) => (tab === 'inactive' ? !s.isActive : s.isActive))
    .filter((s) => !q || `${s.displayName} ${s.email ?? ''}`.toLowerCase().includes(q));
  const roles = (config?.roles ?? []).filter((r) => r.permissions.length > 0);

  async function toggleActive(s: Staff) {
    setConfirming(null);
    setError(null);
    try {
      await api.updateStaff(s.id, { isActive: !s.isActive });
      toast(s.isActive ? `${s.displayName} can no longer sign in` : `${s.displayName} reactivated`);
      reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Shell
      me={me}
      title="Staff"
      subtitle="Who works here, what they can do, and how they sign in. The server checks every action."
      actions={
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>
          Add staff member
        </button>
      }
    >
      <ErrorBox error={error} />
      <div className="tabs-line" role="tablist">
        {(
          [
            ['active', 'Team', config?.staff.filter((s) => s.isActive).length],
            ['inactive', 'Inactive', config?.staff.filter((s) => !s.isActive).length],
            ['roles', 'Roles & permissions', roles.length],
          ] as const
        ).map(([k, label, n]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? 'on' : ''}
            onClick={() => setTab(k)}
          >
            {label}
            {n !== undefined ? <span className="count">{n}</span> : null}
          </button>
        ))}
      </div>
      {!config ? (
        <Skeleton rows={6} />
      ) : tab === 'roles' ? (
        <section className="card">
          <div className="table-scroll">
            <table className="list matrix">
              <thead>
                <tr>
                  <th>Permission</th>
                  {roles.map((r) => (
                    <th key={r.id} className="center">
                      {r.name}
                    </th>
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
                          <span className="yes">
                            <Icon name="check" size={18} label="Yes" />
                          </span>
                        ) : (
                          <span className="no">–</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-body small muted">
            Staff, devices and settings management always need an email and password sign-in, even for owners:
            a PIN only unlocks the tills.
          </div>
        </section>
      ) : (
        <section className="card">
          <div className="toolbar">
            <input
              className="search"
              placeholder="Search by name or email"
              aria-label="Search staff"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {people.length === 0 && q ? (
            <Empty title="Nothing matches">Try another name or email.</Empty>
          ) : people.length === 0 ? (
            <Empty
              title={tab === 'inactive' ? 'No inactive staff' : 'No staff yet'}
              action={
                tab === 'active' ? (
                  <button type="button" className="btn primary" onClick={() => setEditing('new')}>
                    Add the first staff member
                  </button>
                ) : null
              }
            >
              {tab === 'active' ? 'Add cashiers, waiters and kitchen staff, and give each one a PIN.' : null}
            </Empty>
          ) : (
            <table className="list">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Sign-in</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {people.map((s) => {
                  const [pinLabel, pinTone] = PIN_STATE[s.pin];
                  return (
                    <tr key={s.id}>
                      <td>
                        <div className="row">
                          <span className="avatar" aria-hidden>
                            {initials(s.displayName)}
                          </span>
                          <div>
                            <strong>{s.displayName}</strong>
                            <div className="small muted">{s.email ?? 'no email'}</div>
                          </div>
                        </div>
                      </td>
                      <td>{s.roleIds.map(roleName).join(', ')}</td>
                      <td>
                        <Badge value={s.pin} label={pinLabel} tone={pinTone} />
                      </td>
                      <td>
                        {s.isActive ? (
                          <Badge value="active" label="Active" tone="ok" />
                        ) : (
                          <Badge value="inactive" label="Inactive" />
                        )}
                      </td>
                      <td className="actions-cell">
                        {s.isActive ? (
                          <button type="button" className="btn sm" onClick={() => setResetting(s)}>
                            {s.pin === 'none' ? 'Set PIN' : 'Reset PIN'}
                          </button>
                        ) : null}
                        <button type="button" className="btn sm" onClick={() => setEditing(s)}>
                          Edit
                        </button>
                        {s.id === me.staffId ? (
                          <span className="small muted you" title="Another owner must change your own access">
                            You
                          </span>
                        ) : (
                          <button
                            type="button"
                            className={`btn sm ${s.isActive ? 'danger' : ''}`}
                            onClick={() => setConfirming(s)}
                          >
                            {s.isActive ? 'Deactivate' : 'Reactivate'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}
      {confirming ? (
        <Modal
          title={`${confirming.isActive ? 'Deactivate' : 'Reactivate'} ${confirming.displayName}?`}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={`btn ${confirming.isActive ? 'danger' : 'primary'}`}
                onClick={() => void toggleActive(confirming)}
              >
                {confirming.isActive ? 'Deactivate' : 'Reactivate'}
              </button>
            </>
          }
        >
          <p className="muted">
            {confirming.isActive
              ? `${confirming.displayName} will be signed out of new sessions, cannot sign in, and their PIN is cleared. Their orders and history stay.`
              : `${confirming.displayName} can sign in again. Give them a new PIN for the tills.`}
          </p>
        </Modal>
      ) : null}
      {editing && config ? (
        <StaffDrawer
          self={editing !== 'new' && editing.id === me.staffId}
          config={config}
          branchId={branchId}
          staff={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            toast(msg);
            reload();
          }}
        />
      ) : null}
      {resetting ? (
        <PinDialog
          staff={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            toast(`New PIN assigned to ${resetting.displayName}. They choose their own at next sign-in.`);
            setResetting(null);
            reload();
          }}
        />
      ) : null}
    </Shell>
  );
}

function StaffDrawer({
  self,
  config,
  branchId,
  staff,
  onClose,
  onSaved,
}: {
  self: boolean;
  config: ConfigurationView;
  branchId: string;
  staff: Staff | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const roles = config.roles.filter((r) => r.permissions.length > 0);
  const [f, setF] = useState({
    displayName: staff?.displayName ?? '',
    email: staff?.email ?? '',
    roleId: staff?.roleIds[0] ?? roles.find((r) => r.name === 'Cashier')?.id ?? roles[0]?.id ?? '',
    pin: '',
    password: '',
    allBranches: staff ? staff.branchId === null : false,
  });
  const [busy, setBusy] = useState(false);
  const close = useGuardedClose(f, onClose);
  const [error, setError] = useState<unknown>(null);
  const role = roles.find((r) => r.id === f.roleId);
  const needsPassword = role ? BACK_OFFICE.has(role.name) : false;
  // PIN problems are shown next to the PIN field; everything else above the buttons.
  const fieldError = (name: string) =>
    name === 'pin' &&
    error instanceof ApiError &&
    (error.code === 'PIN_IN_USE' || (error.code === 'VALIDATION_FAILED' && /PIN/.test(error.message)))
      ? error.message
      : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (staff) {
        await api.updateStaff(staff.id, {
          displayName: f.displayName,
          // Your own access is changed by another owner (the server refuses it too).
          ...(self ? {} : { roleIds: [f.roleId], branchId: f.allBranches ? null : branchId }),
          ...(f.password ? { password: f.password } : {}),
        });
        onSaved(`${f.displayName} updated`);
      } else {
        await api.createStaff({
          displayName: f.displayName,
          email: f.email,
          roleIds: [f.roleId],
          branchId: f.allBranches ? null : branchId,
          pin: f.pin || null,
          password: f.password || null,
        });
        onSaved(`${f.displayName} added${f.pin ? '. They set their own PIN at first sign-in.' : ''}`);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      title={staff ? `Edit ${staff.displayName}` : 'Add staff member'}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="staff-form" className="btn primary" disabled={busy}>
            {busy ? 'Saving…' : staff ? 'Save changes' : 'Add staff member'}
          </button>
        </>
      }
    >
      <form id="staff-form" onSubmit={submit}>
        <FormSection title="Staff details" description="How they appear on orders, receipts and reports.">
          <Field label="Full name" required>
            <input
              required
              value={f.displayName}
              onChange={(e) => setF({ ...f, displayName: e.target.value })}
              placeholder="e.g. John Mensah"
            />
          </Field>
          <Field label="Email" required hint="Used only to recover a forgotten PIN or password.">
            <input
              type="email"
              required
              disabled={!!staff}
              value={f.email}
              onChange={(e) => setF({ ...f, email: e.target.value })}
              placeholder="john@example.com"
            />
          </Field>
        </FormSection>
        <FormSection
          title="Access"
          description={
            self
              ? 'This is you. Another owner changes your own role, so nobody can lock themselves out by mistake.'
              : 'What they can do. The server enforces it on every action.'
          }
        >
          <Field label="Role" required>
            <select disabled={self} value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <label className="check">
            <input
              type="checkbox"
              disabled={self}
              checked={f.allBranches}
              onChange={(e) => setF({ ...f, allBranches: e.target.checked })}
            />
            Works in every branch
          </label>
        </FormSection>
        {!staff ? (
          <FormSection
            title="Staff PIN"
            description="For signing in on the restaurant's tills. They replace it with their own PIN the first time they sign in."
          >
            <Field
              label="Starting PIN"
              hint="4 to 6 digits. Not 1234, 1111 or similar."
              error={fieldError('pin')}
            >
              <input
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={f.pin}
                onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })}
                aria-invalid={fieldError('pin') ? true : undefined}
              />
            </Field>
          </FormSection>
        ) : null}
        <FormSection
          title="Back-office password"
          description={
            needsPassword
              ? 'Managers and owners sign in to the back office with email and password.'
              : 'Optional. Staff who only use the tills do not need one.'
          }
        >
          <Field
            label={staff ? 'New password (leave empty to keep)' : 'Password'}
            hint="At least 10 characters."
          >
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={f.password}
              onChange={(e) => setF({ ...f, password: e.target.value })}
            />
          </Field>
        </FormSection>
        <ErrorBox error={fieldError('pin') ? null : error} />
      </form>
    </Drawer>
  );
}

function PinDialog({ staff, onClose, onDone }: { staff: Staff; onClose: () => void; onDone: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.assignPin(staff.id, pin);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${staff.pin === 'none' ? 'Set' : 'Reset'} PIN — ${staff.displayName}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="pin-form" className="btn primary" disabled={busy || pin.length < 4}>
            {busy ? 'Saving…' : 'Assign PIN'}
          </button>
        </>
      }
    >
      <form id="pin-form" className="form" onSubmit={submit}>
        <div className="muted small">
          Tell {staff.displayName.split(' ')[0]} this starting PIN in person. Their previous PIN stops working
          now, and they must choose their own PIN at their next sign-in. You will never see their PIN again.
        </div>
        <Field label="Starting PIN" hint="4 to 6 digits">
          <input
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}
