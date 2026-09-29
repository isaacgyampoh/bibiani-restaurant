import type { ConfigEntity, ConfigurationView, OperationsView } from '@rp/contracts';
import { useState } from 'react';
import { linkTo } from '../../infra/router';
import { api } from '../../infra/session';
import { ErrorBox, Field, Modal } from '../../ui/components';

type Row = Record<string, unknown>;
type Device = OperationsView['devices'][number];
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** The Windows program that prints for MY FOOD (built by the desktop workflow, published on GitHub). */
export const PRINTING_DOWNLOAD =
  'https://github.com/isaacgyampoh/bibiani-restaurant/releases/latest/download/MY-FOOD-Printing-Setup.exe';

/** Addresses that are almost always the Wi-Fi router, not a printer. */
export const looksLikeRouter = (address: string | null) =>
  /^\d+\.\d+\.\d+\.(1|254)(:\d+)?$/.test(address ?? '');

const ago = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';

/**
 * "Is printing working, and if not, what do I do?" in plain words, at the top of Devices & printing.
 * Printing needs a program on a PC in the restaurant (MY FOOD Printing, or the MY FOOD Hub): a
 * browser cannot send to receipt printers by itself.
 */
export function PrintingHealth({
  devices,
  config,
  branchId,
  onEnterCode,
}: {
  devices: Device[];
  config: ConfigurationView;
  branchId: string;
  onEnterCode: (d: { id: string; name: string }) => void;
}) {
  const printers = devices.filter((d) => d.kind === 'printer' && d.isActive);
  const agents = devices.filter((d) => d.kind === 'print_agent' && d.isActive);
  const hub = devices.find((d) => d.kind === 'hub' && d.hub?.runsBranch);
  const runningAgents = agents.filter((a) => a.status === 'online');
  const waiting = printers.reduce((n, p) => n + (p.printer?.waitingJobs ?? 0), 0);
  const problems: { text: string; action?: { label: string; href: string } }[] = [];

  for (const p of printers) {
    const info = p.printer;
    if (!info) continue;
    if (info.connection === 'network_escpos' && looksLikeRouter(info.address))
      problems.push({
        text: `${p.name}: ${info.address} is usually the Wi-Fi router, not a printer. Use "Search the network" in MY FOOD Printing to find the printer's real address, then Edit the printer.`,
      });
    if (!info.address) problems.push({ text: `${p.name} has no address. Edit it and enter its address.` });
    if (!hub && !info.agentDeviceId)
      problems.push({ text: `${p.name} is not assigned to a printing PC. Edit it and choose "Printed by".` });
    if (info.lastError && info.healthy === false)
      problems.push({
        text: `${p.name}: the printing PC cannot reach it (${info.lastError}). Check it is on, has paper and is connected.`,
      });
  }
  const stations = (config.stations as Row[]).filter((s) => s.branchId === branchId && s.isActive !== false);
  const outputs = config.stationOutputs as Row[];
  const printerIds = new Set(printers.map((p) => p.id));
  if (printers.length)
    for (const s of stations)
      if (!outputs.some((o) => o.stationId === s.id && printerIds.has(str(o.deviceId))))
        problems.push({
          text: `${str(s.name)} station does not print: its tickets go to screens only. Connect a printer to it if tickets should print there.`,
          action: { label: 'Stations & routing', href: '/routing' },
        });
  const tills = (config.devices as Row[]).filter(
    (d) => d.kind === 'pos' && d.branchId === branchId && d.isActive !== false,
  );
  if (printers.length && tills.length && !tills.some((t) => t.receiptPrinterId))
    problems.push({
      text: 'No till has a receipt printer. Edit a till and choose its receipt printer to print receipts and bills.',
    });

  const neverRan = !hub && runningAgents.length === 0 && agents.every((a) => a.status === 'never_seen');
  const stopped = !hub && runningAgents.length === 0 && !neverRan;
  if (printers.length === 0 && problems.length === 0)
    return (
      <div className="printing-health info">
        <strong>No printers yet.</strong> Add a printer below (type: printer) if the restaurant prints tickets
        or receipts. Kitchen screens work without printers.
      </div>
    );

  return (
    <div
      className={`printing-health ${neverRan || stopped ? 'bad' : problems.length ? 'warn' : 'ok'}`}
      role="status"
    >
      {neverRan ? (
        <>
          <strong>Printing is not running yet.</strong> A browser cannot send to receipt printers by itself:
          one PC in the restaurant runs <b>MY FOOD Printing</b> and prints for everyone.
          <ol>
            <li>
              On a Windows PC at the counter that stays on during service, download and install{' '}
              <a href={PRINTING_DOWNLOAD}>MY FOOD Printing</a>.
            </li>
            <li>
              It shows a code. Press <b>Enter code from device</b> on{' '}
              {agents[0] ? (
                <button
                  type="button"
                  className="link"
                  onClick={() => onEnterCode({ id: agents[0]!.id, name: agents[0]!.name })}
                >
                  {agents[0].name}
                </button>
              ) : (
                'the print agent (add a device of type "print agent" first)'
              )}{' '}
              and type it.
            </li>
            <li>
              In MY FOOD Printing, use “Search the network” to find each printer, then Edit the printer here
              with that address.
            </li>
          </ol>
        </>
      ) : stopped ? (
        <>
          <strong>Printing has stopped.</strong> MY FOOD Printing on {agents.map((a) => a.name).join(', ')}{' '}
          last reported{' '}
          {ago(
            agents
              .map((a) => a.lastSeenAt)
              .filter(Boolean)
              .sort()
              .at(-1) ?? null,
          )}
          . Check that PC is switched on, connected to the internet, and that MY FOOD Printing is running (its
          icon is next to the clock).
        </>
      ) : problems.length ? (
        <strong>Printing is running, but some things need attention:</strong>
      ) : (
        <>
          <strong>Printing is on.</strong>{' '}
          {hub
            ? `The hub ${hub.name} prints for this branch.`
            : `${runningAgents.map((a) => a.name).join(', ')} is running`}
          {printers.length
            ? ` · ${printers.filter((p) => p.status === 'online').length} of ${printers.length} printers ready.`
            : '.'}
        </>
      )}
      {waiting > 0 ? (
        <p>
          {waiting} print job{waiting === 1 ? ' is' : 's are'} waiting
          {neverRan || stopped ? ' and will print as soon as printing runs.' : '.'}
        </p>
      ) : null}
      {problems.length ? (
        <ul>
          {problems.map((p) => (
            <li key={p.text}>
              {p.text}{' '}
              {p.action ? (
                <a href={p.action.href} onClick={linkTo(p.action.href)}>
                  {p.action.label}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Sends a test page and follows it: printed, failed (with the reason), or not picked up because
 * no printing program is running. Never just "queued".
 */
export async function testPrintAndFollow(
  printer: { id: string; name: string },
  branchId: string,
  onUpdate: (text: string, tone: 'info' | 'ok' | 'bad') => void,
): Promise<void> {
  const { printJobId } = await api.testPrint(printer.id, crypto.randomUUID());
  onUpdate(`Test page sent to ${printer.name}. Waiting for the printer…`, 'info');
  const end = Date.now() + 25_000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2500));
    const queue = await api.printQueue(branchId).catch(() => null);
    const job = queue?.jobs.find((j) => j.id === printJobId);
    if (queue && !job) {
      onUpdate(`${printer.name} printed the test page.`, 'ok');
      return;
    }
    if (job && (job.status === 'failed' || job.status === 'dead')) {
      onUpdate(
        `${printer.name} did not print: ${job.lastError ?? 'the printer could not be reached'}.`,
        'bad',
      );
      return;
    }
  }
  onUpdate(
    `${printer.name} has not printed yet: the test page is waiting because no printing program picked it up. Check that MY FOOD Printing is running on the printing PC.`,
    'bad',
  );
}

/** Edit an existing device: printer settings, a till's receipt printer, a kitchen screen's station. */
export function EditDeviceDialog({
  device,
  config,
  branchId,
  save,
  onClose,
  onDone,
}: {
  device: Row;
  config: ConfigurationView;
  branchId: string;
  save: (e: ConfigEntity, r: Row) => Promise<boolean>;
  onClose: () => void;
  onDone: () => void;
}) {
  // Configuration rows carry the printer's settings on the device row itself.
  const printer = device;
  const [f, setF] = useState({
    name: str(device.name),
    connection: str(printer?.connection) || 'network_escpos',
    address: str(printer?.address),
    paperWidthMm: str(printer?.paperWidthMm) || '80',
    agentDeviceId: str(printer?.agentDeviceId),
    backupPrinterId: str(printer?.backupPrinterId),
    receiptPrinterId: str(device.receiptPrinterId),
    stationId: str(device.stationId),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const devices = config.devices as Row[];
  const agents = devices.filter((d) => d.kind === 'print_agent' || d.kind === 'hub');
  const printers = devices.filter((d) => d.kind === 'printer' && d.id !== device.id && d.isActive !== false);
  const stations = (config.stations as Row[]).filter((s) => s.branchId === branchId);
  const kind = str(device.kind);
  const routerWarning = kind === 'printer' && f.connection === 'network_escpos' && looksLikeRouter(f.address);

  async function submit() {
    setBusy(true);
    setError(null);
    const ok = await save('device', {
      id: device.id,
      branchId: device.branchId,
      kind,
      name: f.name.trim(),
      isActive: device.isActive !== false,
      stationId: kind === 'kds' ? f.stationId || null : (device.stationId ?? null),
      receiptPrinterId: kind === 'pos' ? f.receiptPrinterId || null : (device.receiptPrinterId ?? null),
      printer:
        kind === 'printer'
          ? {
              connection: f.connection,
              address: f.address.trim(),
              agentDeviceId: f.agentDeviceId || null,
              paperWidthMm: Number(f.paperWidthMm) === 58 ? 58 : 80,
              backupPrinterId: f.backupPrinterId || null,
            }
          : null,
    }).catch((e) => {
      setError(e);
      return false;
    });
    setBusy(false);
    if (ok) onDone();
  }

  return (
    <Modal
      title={`Edit ${str(device.name)}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || (kind === 'printer' && !f.address.trim())}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      {kind === 'printer' ? (
        <>
          <Field label="How is it connected?">
            <select value={f.connection} onChange={(e) => setF({ ...f, connection: e.target.value })}>
              <option value="network_escpos">Network (cable or Wi-Fi, has an IP address)</option>
              <option value="usb_escpos">USB cable into the printing PC</option>
            </select>
          </Field>
          <Field
            label={f.connection === 'usb_escpos' ? 'Windows printer name' : 'Printer IP address'}
            hint={
              f.connection === 'usb_escpos'
                ? 'Exactly as MY FOOD Printing lists it under "USB printers on this PC".'
                : 'e.g. 192.168.1.50. MY FOOD Printing can find it: "Search the network". The printer\'s self-test page also shows it.'
            }
            error={
              routerWarning
                ? `${f.address} is usually the Wi-Fi router, not a printer. Check the address.`
                : null
            }
          >
            <input
              value={f.address}
              maxLength={80}
              autoComplete="off"
              onChange={(e) => setF({ ...f, address: e.target.value })}
            />
          </Field>
          <Field label="Paper width">
            <select value={f.paperWidthMm} onChange={(e) => setF({ ...f, paperWidthMm: e.target.value })}>
              <option value="80">80 mm</option>
              <option value="58">58 mm</option>
            </select>
          </Field>
          <Field
            label="Printed by"
            hint={
              f.connection === 'usb_escpos'
                ? 'The PC the USB cable is plugged into.'
                : 'The PC running MY FOOD Printing (or the hub).'
            }
          >
            <select value={f.agentDeviceId} onChange={(e) => setF({ ...f, agentDeviceId: e.target.value })}>
              <option value="">Choose…</option>
              {agents.map((a) => (
                <option key={str(a.id)} value={str(a.id)}>
                  {str(a.name)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Backup printer (optional)" hint="Used when this printer stays unreachable.">
            <select
              value={f.backupPrinterId}
              onChange={(e) => setF({ ...f, backupPrinterId: e.target.value })}
            >
              <option value="">None</option>
              {printers.map((p) => (
                <option key={str(p.id)} value={str(p.id)}>
                  {str(p.name)}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : null}
      {kind === 'pos' ? (
        <Field label="Receipt printer" hint="Receipts and bills from this till print here.">
          <select
            value={f.receiptPrinterId}
            onChange={(e) => setF({ ...f, receiptPrinterId: e.target.value })}
          >
            <option value="">None</option>
            {devices
              .filter((d) => d.kind === 'printer' && d.isActive !== false)
              .map((p) => (
                <option key={str(p.id)} value={str(p.id)}>
                  {str(p.name)}
                </option>
              ))}
          </select>
        </Field>
      ) : null}
      {kind === 'kds' ? (
        <Field label="Station">
          <select value={f.stationId} onChange={(e) => setF({ ...f, stationId: e.target.value })}>
            <option value="">—</option>
            {stations.map((s) => (
              <option key={str(s.id)} value={str(s.id)}>
                {str(s.name)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <ErrorBox error={error} />
    </Modal>
  );
}
