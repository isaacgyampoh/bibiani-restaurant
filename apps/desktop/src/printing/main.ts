import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  Tray,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { type PairingStore, PrintStation, type SavedPairing } from './station';

/**
 * MY FOOD Printing for Windows: runs on one PC in the restaurant and prints MY FOOD's kitchen
 * tickets, receipts and bills (network printers and USB printers plugged into this PC). Starts with
 * Windows; closing the window keeps printing running in the tray.
 */
const CLOUD_URL = process.env.MYFOOD_CLOUD_URL ?? 'https://www.chefelisha.cc';
const SUPABASE_URL = process.env.MYFOOD_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.MYFOOD_SUPABASE_ANON_KEY ?? '';
const CHANNEL = process.env.MYFOOD_CHANNEL ?? 'test';
const TITLE = CHANNEL === 'production' ? 'MY FOOD Printing' : 'MY FOOD Printing (TEST)';

if (!app.requestSingleInstanceLock()) app.exit(0);

// The page, preload and icon are built next to main.cjs (packaged or not).
const resources = __dirname;
const dataDir = join(app.getPath('userData'), 'printing');
const logFile = join(dataDir, 'printing.log');
const log =
  (level: string) =>
  (event: string, fields: Record<string, unknown> = {}) => {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        logFile,
        `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
        {
          flag: 'a',
        },
      );
    } catch {
      // logging must never stop printing
    }
  };

/** The pairing (this PC's MY FOOD device login), encrypted with the Windows key store. */
function keyStore(): PairingStore {
  const file = join(dataDir, 'pairing.bin');
  const read = (): SavedPairing | null => {
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(safeStorage.decryptString(readFileSync(file))) as SavedPairing;
    } catch {
      return null;
    }
  };
  const write = (p: SavedPairing | null) => {
    mkdirSync(dataDir, { recursive: true });
    if (!p) {
      writeFileSync(file, Buffer.alloc(0));
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The Windows key store is not available');
    writeFileSync(file, safeStorage.encryptString(JSON.stringify(p)), { mode: 0o600 });
  };
  return {
    load: read,
    save: write,
    saveToken: (refreshToken) => {
      const p = read();
      if (p) write({ ...p, refreshToken });
    },
  };
}

let window: BrowserWindow | null = null;
let quitting = false;
let station: PrintStation;

function show() {
  if (window) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 900,
    height: 760,
    title: TITLE,
    icon: join(resources, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(resources, 'printing-preload.cjs'),
    },
  });
  void window.loadFile(join(resources, 'printing.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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

app.on('second-instance', show);

void app.whenReady().then(() => {
  app.setLoginItemSettings({ openAtLogin: true });
  station = new PrintStation({
    cloudUrl: CLOUD_URL,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    store: keyStore(),
    journalFile: join(dataDir, 'print-journal.jsonl'),
    version: app.getVersion(),
    log: { info: log('info'), warn: log('warn'), error: log('error') },
  });
  station.start();

  ipcMain.handle('printing:status', () => ({
    ...station.status(),
    version: app.getVersion(),
    title: TITLE,
    cloud: CLOUD_URL,
  }));
  ipcMain.handle('printing:scan', () => station.scan());
  ipcMain.handle('printing:newCode', () => station.newCode());
  ipcMain.handle('printing:usb', () => station.usbPrinters());
  ipcMain.handle('printing:refresh', () => station.refreshPrinters());
  ipcMain.handle(
    'printing:test',
    (_e, p: { connection: 'network_escpos' | 'usb_escpos'; address: string; paperWidthMm: 58 | 80 }) => {
      if (typeof p?.address !== 'string' || p.address.length > 80) throw new Error('Invalid printer');
      return station.testPrint({
        connection: p.connection === 'usb_escpos' ? 'usb_escpos' : 'network_escpos',
        address: p.address,
        paperWidthMm: p.paperWidthMm === 58 ? 58 : 80,
      });
    },
  );
  ipcMain.handle('printing:copy', (_e, text: string) => clipboard.writeText(String(text).slice(0, 200)));
  ipcMain.handle('printing:forget', async () => {
    const answer = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Disconnect'],
      defaultId: 0,
      message: 'Disconnect this PC from MY FOOD?',
      detail: 'Printing stops until this PC is connected again with a new code.',
    });
    if (answer.response === 1) station.forget();
  });

  const tray = new Tray(
    nativeImage.createFromPath(join(resources, 'icon.png')).resize({ width: 16, height: 16 }),
  );
  tray.setToolTip(TITLE);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${TITLE}`, click: show },
      { type: 'separator' },
      {
        label: 'Quit (printing stops)',
        click: () => {
          quitting = true;
          station.stop();
          app.quit();
        },
      },
    ]),
  );
  tray.on('double-click', show);
  Menu.setApplicationMenu(null);
  show();

  if (app.isPackaged && CHANNEL === 'production') {
    autoUpdater.logger = {
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      debug: () => {},
    } as never;
    void autoUpdater
      .checkForUpdatesAndNotify()
      .catch((e) => log('warn')('printing.update_check_failed', { error: String(e) }));
  }
});

app.on('window-all-closed', () => {});
