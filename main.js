const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, screen, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const io = require('socket.io-client');

const store = new Store({
  defaults: {
    kickChannel: '',
    kickChatroomId: '',
    streamlabsToken: '',
    showTwitchChat: false,
    twitchChannel: '',
    fontSize: 16,
    bgOpacity: 0.45,
    showChat: true,
    showFollows: true,
    showSubs: true,
    showGiftedSubs: true,
    showTips: true,
    showViewerCount: true,
    showNanodrops: true,
    nanodropsFaucetId: 'a4552cef',
    nanodropsFaucetId2: '',
    dropDecimals: 4,
    obsEnabled: false,
    obsWsHost: '127.0.0.1',
    obsWsPort: 4455,
    obsWsPassword: '',
    obsMicSource: 'Mic/Aux',
    obsDesktopSource: 'Desktop Audio',
    obsWebcamSource: 'Webcam',
    lockShortcut: 'Control+Shift+L',
    windowBounds: { x: undefined, y: undefined, width: 480, height: 640 },
    clickThrough: false
  }
});

let mainWindow = null;
let tray = null;
let locked = false; // click-through state
let streamlabsSocket = null;
let currentLockAccelerator = null; // whatever's actually registered right now

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function connectStreamlabs() {
  if (streamlabsSocket) {
    streamlabsSocket.close();
    streamlabsSocket = null;
  }
  const token = store.get('streamlabsToken');
  if (!token) {
    sendToRenderer('streamlabs-status', { connected: false, message: 'No token set' });
    return;
  }
  sendToRenderer('streamlabs-status', { connected: false, message: 'Connecting…' });

  streamlabsSocket = io(`https://sockets.streamlabs.com?token=${encodeURIComponent(token)}`, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 3000
  });

  streamlabsSocket.on('connect', () => {
    sendToRenderer('streamlabs-status', { connected: true, message: 'Connected' });
  });

  streamlabsSocket.on('disconnect', () => {
    sendToRenderer('streamlabs-status', { connected: false, message: 'Disconnected, retrying…' });
  });

  streamlabsSocket.on('connect_error', (err) => {
    sendToRenderer('streamlabs-status', { connected: false, message: `Connect error: ${err.message}` });
  });

  streamlabsSocket.on('event', (eventData) => {
    // Raw payload is forwarded as-is; renderer decides how to display it and
    // logs unrecognized shapes to the devtools console so platform-specific
    // fields (e.g. how a Kicks tip differs from a PayPal tip) can be checked
    // against what actually arrives, since Streamlabs doesn't fully document
    // per-platform payload differences.
    sendToRenderer('streamlabs-event', eventData);
  });
}

// ---------------------------------------------------------------------------
// NanoDrops – public, unauthenticated JSON endpoints, so this is fetched from
// the main process (not the renderer) to sidestep any browser CORS policy
// entirely rather than relying on the site sending permissive headers.
// ---------------------------------------------------------------------------

let nanodropsTimer = null;

async function fetchFaucet(faucetId) {
  const res = await fetch(`https://nanodrops.org/api/faucets/${encodeURIComponent(faucetId)}`);
  if (!res.ok) throw new Error(`faucet endpoint HTTP ${res.status}`);
  return res.json();
}

// Trims one faucet's response down to just what the renderer needs, and
// namespaces message/drop ids by faucet so two faucets' ids can never
// collide once merged together.
function extractFaucetData(faucet, faucetId) {
  return {
    watchers: faucet?.faucet?.watchers ?? null,
    balanceXno: faucet?.faucet?.balance?.xno ?? null,
    // `null` here means the API didn't report a status (older/partial
    // response) – treated as "online" downstream so that case doesn't
    // silently hide a balance that's otherwise fine to show.
    online: faucet?.faucet?.online ?? faucet?.online ?? null,
    messages: Array.isArray(faucet?.messages)
      ? faucet.messages.map((m) => ({ id: `${faucetId}:${m.id}`, name: m.name, text: m.text, amount: m.amount }))
      : [],
    drops: Array.isArray(faucet?.drops)
      ? faucet.drops.map((d) => ({
          id: `${faucetId}:${d.id}`,
          at: d.at,
          viewerName: d.viewerName,
          streamer: d.streamer,
          amountXno: d.amount && d.amount.xno != null ? Number(d.amount.xno) : null
        }))
      : []
  };
}

async function pollNanodrops() {
  if (!store.get('showNanodrops')) return;
  const faucetId1 = store.get('nanodropsFaucetId');
  const faucetId2 = store.get('nanodropsFaucetId2');
  if (!faucetId1 && !faucetId2) {
    sendToRenderer('nanodrops-status', { ok: false, message: 'No faucet ID set' });
    return;
  }
  try {
    const [faucet1, faucet2, statsRes] = await Promise.all([
      faucetId1 ? fetchFaucet(faucetId1) : Promise.resolve(null),
      faucetId2 ? fetchFaucet(faucetId2) : Promise.resolve(null),
      fetch('https://nanodrops.org/api/stats')
    ]);
    if (!statsRes.ok) throw new Error(`stats endpoint HTTP ${statsRes.status}`);
    const stats = await statsRes.json();

    const hourlyRateXno = Number(stats?.hourlyRate?.xno ?? 0);
    const usdPerXno = Number(stats?.usdPerXno ?? 0);

    const d1 = faucetId1 ? extractFaucetData(faucet1, faucetId1) : null;
    const d2 = faucetId2 ? extractFaucetData(faucet2, faucetId2) : null;

    // Watchers are genuinely per-faucet numbers, so they're summed into one
    // combined total when both are set; hourly rate and network pool stats
    // already come from the shared /api/stats endpoint (not faucet-specific),
    // so there's nothing to combine there.
    const watcherValues = [d1?.watchers, d2?.watchers].filter((v) => v != null);

    // Faucet balance: only faucets whose stream is currently online count.
    // If a faucet is offline, its balance is left out entirely – if the
    // other one is online, only that one's balance shows; if both are
    // offline, no balance is shown. If both are online, show whichever
    // balance is bigger rather than combining them. A faucet with no
    // `online` status reported (null) is treated as online, so this
    // doesn't hide balances for setups where that field isn't present.
    const onlineFaucets = [d1, d2].filter((d) => d && d.online !== false);
    const balanceValues = onlineFaucets.map((d) => d.balanceXno).filter((v) => v != null);
    const faucetBalanceXno = balanceValues.length ? Math.max(...balanceValues.map(Number)) : null;

    sendToRenderer('nanodrops-data', {
      streamWatchers: watcherValues.length ? watcherValues.reduce((a, b) => a + Number(b), 0) : null,
      faucetBalanceXno,
      hourlyRateUsd: usdPerXno ? hourlyRateXno * usdPerXno : null,
      networkActiveUsers: stats?.activeUsers ?? null,
      networkActiveNanoXno: stats?.activeNano?.xno ?? null,
      // TTS/faucet messages (viewers leaving a note with their drop) and the
      // raw per-drop log, merged from both faucets and sorted oldest-first.
      messages: [...(d1?.messages ?? []), ...(d2?.messages ?? [])],
      drops: [...(d1?.drops ?? []), ...(d2?.drops ?? [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    });
    sendToRenderer('nanodrops-status', {
      ok: true,
      message: faucetId1 && faucetId2 ? 'Connected (2 faucets)' : 'Connected'
    });
  } catch (err) {
    sendToRenderer('nanodrops-status', { ok: false, message: err.message });
  }
}

function startNanodropsPolling() {
  clearInterval(nanodropsTimer);
  pollNanodrops();
  nanodropsTimer = setInterval(pollNanodrops, 15000);
}

function createWindow() {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 260,
    minHeight: 200,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('focus', () => sendToRenderer('window-focus-changed', true));
  mainWindow.on('blur', () => sendToRenderer('window-focus-changed', false));
  mainWindow.webContents.on('did-finish-load', () => {
    sendToRenderer('window-focus-changed', mainWindow.isFocused());
  });

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    store.set('windowBounds', mainWindow.getBounds());
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Tries to register `accelerator` for the lock/click-through toggle. On
// success, unregisters whatever was previously bound and adopts the new one.
// On failure (already in use by the OS/another app), leaves the existing
// binding untouched and returns false so the caller can report it.
function applyLockShortcut(accelerator) {
  if (currentLockAccelerator === accelerator) return true;
  const ok = globalShortcut.register(accelerator, () => setClickThrough(!locked));
  if (!ok) return false;
  if (currentLockAccelerator) globalShortcut.unregister(currentLockAccelerator);
  currentLockAccelerator = accelerator;
  return true;
}

function setClickThrough(state) {
  locked = state;
  if (mainWindow) {
    // forward: true still delivers mousemove so we could show/hide chrome later if desired
    mainWindow.setIgnoreMouseEvents(state, { forward: true });
  }
  if (tray) buildTrayMenu();
  if (mainWindow) mainWindow.webContents.send('clickthrough-changed', state);
}

function buildTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Kick Stream Overlay', enabled: false },
    { type: 'separator' },
    {
      label: locked ? 'Unlock (allow interaction)' : 'Lock (click-through)',
      click: () => setClickThrough(!locked)
    },
    {
      label: 'Show / Focus',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Open Settings',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.send('open-settings');
        }
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('Kick Stream Overlay');
  buildTrayMenu();
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  connectStreamlabs();
  startNanodropsPolling();

  // Toggles click-through so you can lock the overlay over a game then get
  // your mouse back without alt-tabbing. Rebindable from Settings; falls
  // back to the default if the saved accelerator can't be registered
  // (e.g. another app already grabbed it).
  if (!applyLockShortcut(store.get('lockShortcut'))) {
    applyLockShortcut('Control+Shift+L');
  }
  // Ctrl+Shift+O toggles the settings panel.
  globalShortcut.register('Control+Shift+O', () => {
    if (mainWindow) mainWindow.webContents.send('open-settings');
  });
  // Ctrl+Shift+I opens DevTools – there's no menu bar (frameless window) to
  // reveal it from otherwise, and it's handy for checking console.debug output.
  globalShortcut.register('Control+Shift+I', () => {
    if (mainWindow) mainWindow.webContents.toggleDevTools();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC ----
ipcMain.handle('get-settings', () => store.store);

ipcMain.handle('set-settings', (event, patch) => {
  const tokenChanged = 'streamlabsToken' in patch && patch.streamlabsToken !== store.get('streamlabsToken');
  store.set(patch);
  if (tokenChanged) connectStreamlabs();
  if ('nanodropsFaucetId' in patch || 'nanodropsFaucetId2' in patch || 'showNanodrops' in patch) pollNanodrops();
  return store.store;
});

ipcMain.handle('reconnect-streamlabs', () => {
  connectStreamlabs();
});

ipcMain.handle('toggle-clickthrough', () => {
  setClickThrough(!locked);
  return locked;
});

ipcMain.handle('set-lock-shortcut', (event, accelerator) => {
  const ok = applyLockShortcut(accelerator);
  if (ok) store.set('lockShortcut', accelerator);
  return { ok, accelerator: currentLockAccelerator };
});

ipcMain.handle('quit-app', () => app.quit());
