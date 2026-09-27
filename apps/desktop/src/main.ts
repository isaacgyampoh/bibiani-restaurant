import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type HubSecrets, runHub, type SecretStore } from '@rp/hub-app/run';
import { app, BrowserWindow, dialog, Menu, nativeImage, safeStorage, shell, Tray } from 'electron';
import { autoUpdater } from 'electron-updater';

/**
 * MY FOOD Hub for Windows. Starts the hub (local database, MY FOOD API and web app for the
 * restaurant network, print agent, sync) and shows the hub window. Closing the window keeps the hub
 * running in the tray: tills depend on it. It starts with Windows.
 */
const PORT = Number(process.env.MYFOOD_HUB_PORT ?? 8080);
const CLOUD_URL = process.env.MYFOOD_CLOUD_URL ?? 'https://bibiani-restaurant.vercel.app';
const SUPABASE_URL = process.env.MYFOOD_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.MYFOOD_SUPABASE_ANON_KEY ?? '';
/** 'production', or 'test' for a hub built against staging (named "MY FOOD Hub (TEST)"). */
const CHANNEL = process.env.MYFOOD_CHANNEL ?? 'test';
const TITLE = CHANNEL === 'production' ? 'MY FOOD Hub' : 'MY FOOD Hub (TEST)';

// Only one hub per PC: a second launch just brings the running hub's window forward.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.exit(0);

const resources = app.isPackaged ? join(__dirname) : join(__dirname, '..', 'app');
const dataDir = join(app.getPath('userData'), 'hub');

/** Hub secrets encrypted with the Windows key store (DPAPI) for this Windows account. */
function keyStoreSecrets(): SecretStore {
  const file = join(dataDir, 'secrets.bin');
  return {
    load: () => {
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(safeStorage.decryptString(readFileSync(file))) as HubSecrets;
      } catch {
        throw new Error(
          'The hub cannot read its protected keys. This happens when MY FOOD Hub runs under a different Windows account than the one that set it up. Sign in to Windows with that account, or contact MY FOOD support.',
        );
      }
    },
    save: (secrets) => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('The Windows key store is not available: the hub cannot protect its secrets');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, safeStorage.encryptString(JSON.stringify(secrets)), { mode: 0o600 });
    },
  };
}

const logFile = () => join(dataDir, 'hub.log');
const log =
  (level: string) =>
  (event: string, fields: Record<string, unknown> = {}) => {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        logFile(),
        `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
        {
          flag: 'a',
        },
      );
    } catch {
      // logging must never stop the hub
    }
  };

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let hubUrl = `http://127.0.0.1:${PORT}`;
let firstRun = false;

/** Opens MY FOOD on this PC: the POS, or a page of the hub (e.g. "/hub" for status and devices). */
function showWindow(path?: string) {
  if (window) {
    if (path) void window.loadURL(`${hubUrl}${path}`);
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1100,
    height: 820,
    title: TITLE,
    icon: join(resources, 'icon.png'),
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // The POS first; the hub page on first start (it shows the code that connects the hub to MY FOOD).
  void window.loadURL(`${hubUrl}${path ?? (firstRun ? '/hub' : '/')}`);
  // Links to the cloud back office open in the normal browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      window?.hide();
    }
  });
  window.on('closed', () => {
    window = null;
  });
}

app.on('second-instance', () => showWindow());

if (primaryInstance) void app.whenReady().then(start);

async function start() {
  app.setLoginItemSettings({ openAtLogin: true });
  let stop: () => void = () => {};
  try {
    const hub = await runHub({
      dataDir,
      port: PORT,
      migrationsDir: join(resources, 'migrations'),
      webDist: join(resources, 'web'),
      cloudApiUrl: CLOUD_URL,
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY,
      secrets: keyStoreSecrets(),
      logger: { info: log('info'), warn: log('warn'), error: log('error') },
      release: `hub-${app.getVersion()}${CHANNEL === 'production' ? '' : '-test'}`,
    });
    stop = hub.stop;
    hubUrl = hub.url;
    firstRun = hub.needsCloudPairing();
  } catch (error) {
    log('error')('hub.start_failed', { error: String(error) });
    dialog.showErrorBox(
      'MY FOOD Hub could not start',
      `${String((error as Error).message ?? error)}\n\nIf another program uses port ${PORT}, close it and start MY FOOD Hub again. Details are in ${logFile()}.`,
    );
    app.exit(1);
    return;
  }

  tray = new Tray(nativeImage.createFromPath(join(resources, 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip(TITLE);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${TITLE}`, click: () => showWindow() },
      { label: 'Open a till on this computer', click: () => void shell.openExternal(hubUrl) },
      { type: 'separator' },
      {
        label: 'Quit (tills stop working)',
        click: () => {
          quitting = true;
          stop();
          app.quit();
        },
      },
    ]),
  );
  tray.on('double-click', () => showWindow());
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'MY FOOD',
        submenu: [
          { label: 'Point of sale', accelerator: 'F1', click: () => showWindow('/') },
          { label: 'Hub status and devices', accelerator: 'F2', click: () => showWindow('/hub') },
          { type: 'separator' },
          { label: 'Reload', role: 'reload' },
          { label: 'Full screen', role: 'togglefullscreen' },
          { type: 'separator' },
          { label: 'Hide window (the hub keeps running)', role: 'close' },
        ],
      },
    ]),
  );
  showWindow();

  if (app.isPackaged && CHANNEL === 'production') {
    autoUpdater.logger = {
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      debug: () => {},
    } as never;
    void autoUpdater
      .checkForUpdatesAndNotify()
      .catch((e) => log('warn')('hub.update_check_failed', { error: String(e) }));
  }
}

// The hub keeps running with no window open.
app.on('window-all-closed', () => {});
