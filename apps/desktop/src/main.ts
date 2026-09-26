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

if (!app.requestSingleInstanceLock()) app.quit();

const resources = app.isPackaged ? join(__dirname) : join(__dirname, '..', 'app');
const dataDir = join(app.getPath('userData'), 'hub');

/** Hub secrets encrypted with the Windows key store (DPAPI) for this Windows account. */
function keyStoreSecrets(): SecretStore {
  const file = join(dataDir, 'secrets.bin');
  return {
    load: () => {
      if (!existsSync(file)) return null;
      return JSON.parse(safeStorage.decryptString(readFileSync(file))) as HubSecrets;
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

function showWindow() {
  if (window) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1100,
    height: 820,
    title: 'MY FOOD Hub',
    icon: join(resources, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  void window.loadURL(`${hubUrl}/hub`);
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

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
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
      release: `hub-${app.getVersion()}`,
    });
    stop = hub.stop;
    hubUrl = hub.url;
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
  tray.setToolTip('MY FOOD Hub');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open MY FOOD Hub', click: showWindow },
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
  tray.on('double-click', showWindow);
  showWindow();

  if (app.isPackaged) {
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
});

// The hub keeps running with no window open.
app.on('window-all-closed', () => {});
