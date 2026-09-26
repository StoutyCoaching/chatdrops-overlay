const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, screen, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const io = require('socket.io-client');

// Only one overlay at a time: a second copy would open a second window and a
// second Streamlabs connection, and its global shortcuts would silently fail
// to register (the first copy already owns them). The second launch just
// hands over to the running one (see the 'second-instance' handler below) and
// exits.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

const store = new Store({
  defaults: {
    kickChannel: '',
    kickChatroomId: '',
    streamlabsToken: '',
    showTwitchChat: false,
    twitchChannel: '',
    kickForcePlatformColor: false,
    twitchForcePlatformColor: false,
    maxBadges: 3,
    fontSize: 16,
    bgOpacity: 0.45,
    dragBarOpacity: 0.35,
    showChat: true,
    showFollows: true,
    showSubs: true,
    showGiftedSubs: true,
    showTips: true,
    showBits: true,
    showRaids: true,
    showViewerCount: true,
    showKickTimer: true,
    showTwitchTimer: true,
    showNanodrops: true,
    nanodropsFaucetId: 'a4552cef',
    nanodropsFaucetId2: '',
    showOfflineFaucets: false,
    dropDecimals: 4,
    xnoDecimals: 2,
    obsEnabled: false,
    obsWsHost: '127.0.0.1',
    obsWsPort: 4455,
    obsWsPassword: '',
    obsMicSource: 'Mic/Aux',
    obsDesktopSource: 'Desktop Audio',
    obsWebcamSource: 'Webcam',
    lockShortcut: 'Control+Shift+L',
    clearChatShortcut: 'F21',
    clearChatGraceMs: 3000,
    windowBounds: { x: undefined, y: undefined, width: 480, height: 640 },
    clickThrough: false
  }
});

let mainWindow = null;
let tray = null;
let locked = false; // click-through state
let streamlabsSocket = null;
let currentLockAccelerator = null; // whatever's actually registered right now
let currentClearChatAccelerator = null; // whatever's actually registered right now

// A few messages are sent once and never repeated (Streamlabs' "Connected" /
// "No token set", the first nanodrops poll). Main starts them the moment the
// window is created, which is usually *before* the page has loaded and
// registered its listeners – so they were silently lost, leaving the startup
// "loading" indicator stuck and the status lines on "Not connected". The
// latest of each is remembered and replayed when the renderer says it's ready.
const REPLAYABLE_CHANNELS = ['nanodrops-data', 'nanodrops-status', 'streamlabs-status'];
const lastSent = {};

function sendToRenderer(channel, payload) {
  if (REPLAYABLE_CHANNELS.includes(channel)) lastSent[channel] = payload;
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

// Every request gets a deadline: polls never overlap (see pollNanodrops), so a
// request that hung forever would otherwise wedge polling for good.
const NANODROPS_FETCH_TIMEOUT_MS = 8000;

// How many polls in a row a source (a faucet, or the network stats) may fail
// before its numbers are treated as gone. Until then its last good values keep
// showing, so a single dropped request doesn't blank the stat chips. Polls are
// 5s apart, so this is roughly 15 seconds.
const NANODROPS_MAX_STALE_POLLS = 3;

async function fetchNanodropsJson(url, label) {
  const res = await fetch(url, { signal: AbortSignal.timeout(NANODROPS_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return res.json();
}

function fetchFaucet(faucetId) {
  return fetchNanodropsJson(`https://nanodrops.org/api/faucets/${encodeURIComponent(faucetId)}`, 'faucet endpoint');
}

function fetchNanodropsStats() {
  return fetchNanodropsJson('https://nanodrops.org/api/stats', 'stats endpoint');
}

// Just the network-wide numbers the renderer shows from /api/stats.
function extractStats(stats) {
  const hourlyRateXno = Number(stats?.hourlyRate?.xno ?? 0);
  const usdPerXno = Number(stats?.usdPerXno ?? 0);
  return {
    hourlyRateUsd: usdPerXno ? hourlyRateXno * usdPerXno : null,
    activeUsers: stats?.activeUsers ?? null,
    activeNanoXno: stats?.activeNano?.xno ?? null
  };
}

// Each request is tracked on its own – a faucet ID typo, or the stats endpoint
// having a bad moment, only affects *that* source rather than failing the
// whole poll (they used to share one Promise.all, so any one failure blanked
// everything, including a perfectly healthy first faucet).
//   key      `faucet:<id>` or `stats`
//   data     last good result (null if never fetched, or failing for too long)
//   fresh    true only if this very poll fetched it successfully
//   failures consecutive failed polls, error = the latest failure's message
const nanodropsSources = new Map();

// Token for the poll currently running, if any. Polls never overlap: a slow
// response could otherwise land *after* a newer one and make the faucet
// balance appear to jump backwards then forwards, firing a false JUICED alert.
let nanodropsActivePoll = null;

function recordNanodropsResult(key, result, transform) {
  const src = nanodropsSources.get(key) || { data: null, fresh: false, failures: 0, error: null };
  let outcome = result;
  if (outcome.status === 'fulfilled') {
    try {
      src.data = transform(outcome.value);
    } catch (err) {
      outcome = { status: 'rejected', reason: err }; // a response we couldn't make sense of counts as a failure
    }
  }
  if (outcome.status === 'fulfilled') {
    src.fresh = true;
    src.failures = 0;
    src.error = null;
  } else {
    src.fresh = false;
    src.failures += 1;
    src.error = (outcome.reason && outcome.reason.message) || String(outcome.reason);
    if (src.failures >= NANODROPS_MAX_STALE_POLLS) src.data = null;
  }
  nanodropsSources.set(key, src);
  return src;
}

// Faucet IDs that should currently be polled (none while the feature is off).
function activeNanodropsFaucetIds() {
  if (!store.get('showNanodrops')) return [];
  return [store.get('nanodropsFaucetId'), store.get('nanodropsFaucetId2')].filter(Boolean);
}

// Called when the nanodrops settings change. Forgets everything tracked for a
// faucet that's no longer active (changed, removed, or the whole feature
// switched off) so that if it comes back it starts from a clean baseline. Left
// in place, the stale balance from before made the first poll after re-enabling
// look like a big unnamed deposit – a false JUICED alert. Also abandons any
// poll still in flight, since it was fetched under the old settings.
function pruneNanodropsState() {
  const active = new Set(activeNanodropsFaucetIds());
  const enabled = !!store.get('showNanodrops');
  Object.keys(prevFaucetState).forEach((id) => {
    if (!active.has(id)) delete prevFaucetState[id];
  });
  Array.from(nanodropsSources.keys()).forEach((key) => {
    const keep = key === 'stats' ? enabled : active.has(key.slice('faucet:'.length));
    if (!keep) nanodropsSources.delete(key);
  });
  if (!enabled) {
    delete lastSent['nanodrops-data'];
    delete lastSent['nanodrops-status'];
  }
  nanodropsActivePoll = null;
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
      ? faucet.messages.map((m) => ({ id: `${faucetId}:${m.id}`, faucetId, name: m.name, text: m.text, amount: m.amount, kind: m.kind ?? null }))
      : [],
    drops: Array.isArray(faucet?.drops)
      ? faucet.drops.map((d) => ({
          id: `${faucetId}:${d.id}`,
          faucetId,
          at: d.at,
          viewerName: d.viewerName,
          streamer: d.streamer,
          amountXno: d.amount && d.amount.xno != null ? Number(d.amount.xno) : null
        }))
      : []
  };
}

// Tracks each faucet's balance and message ids poll-to-poll, purely to spot
// balance increases that don't come with a message attached (someone
// deposited without leaving a name/note) – see computeAnonymousDeposit.
let prevFaucetState = {};

// Below this, a candidate "anonymous deposit" reading is treated as noise
// rather than a real one, mainly to absorb tiny floating-point residue
// between the balance total and the sum of named message amounts.
const ANONYMOUS_DEPOSIT_NOISE_FLOOR_XNO = 0.0001;

function computeAnonymousDeposit(faucetId, data) {
  if (!data) return null;
  const prev = prevFaucetState[faucetId];
  const currentBalance = data.balanceXno != null ? Number(data.balanceXno) : null;
  // Accumulated across polls (not just replaced with the latest snapshot),
  // so a message that briefly drops out of the faucet's "recent" window and
  // later reappears in it is never mistaken for a fresh one and wrongly
  // netted a second time.
  const knownMessageIds = prev ? new Set(prev.messageIds) : new Set();

  let anonymousXno = 0;
  let debugInfo = null;
  if (prev && prev.balanceXno != null && currentBalance != null) {
    const rawDelta = currentBalance - prev.balanceXno;
    // Deliberately NOT correcting for drops paid out in the same window
    // (an earlier version tried adding those back in, reasoning that a
    // drop landing alongside a deposit shrinks the reported delta). That
    // assumed the drops list and the balance figure are captured in sync
    // within a single API response, but they evidently aren't – the
    // balance doesn't (yet) reflect a drop by the time it's already in the
    // drops list, so "adding it back" fabricated a phantom deposit
    // tracking (a fraction of) every drop's amount, firing constantly.
    // Only messages that are new since the last poll and represent a
    // faucet contribution (not a direct viewer tip, which bypasses the
    // pool) plausibly account for part of a balance increase; whatever the
    // raw delta isn't explained by those must be an unnamed deposit – if it
    // clears the noise floor above. A real deposit landing in the exact
    // same ~5s window as viewer drops can still undershoot slightly as a
    // result, but that's a smaller, occasional error – not an alert firing
    // on essentially every drop.
    const newNamed = data.messages.filter((m) => !knownMessageIds.has(m.id) && m.kind !== 'tip');
    const newNamedXno = newNamed.reduce((sum, m) => sum + (m.amount && m.amount.xno != null ? Number(m.amount.xno) : 0), 0);
    const candidateXno = rawDelta - newNamedXno;
    if (candidateXno > ANONYMOUS_DEPOSIT_NOISE_FLOOR_XNO) {
      anonymousXno = candidateXno;
      debugInfo = {
        rawDelta,
        newNamedXno,
        candidateXno,
        netted: newNamed.map((m) => ({ id: m.id, kind: m.kind, xno: m.amount?.xno }))
      };
    }
  }

  data.messages.forEach((m) => knownMessageIds.add(m.id));
  // Cap like the renderer's own dedup sets do, so this can't grow forever.
  const trimmedMessageIds = knownMessageIds.size > 1000
    ? new Set(Array.from(knownMessageIds).slice(-500))
    : knownMessageIds;
  prevFaucetState[faucetId] = { balanceXno: currentBalance, messageIds: trimmedMessageIds };

  // No previous balance to diff against yet (first poll for this faucet) –
  // skip rather than treat the faucet's whole existing balance as a fresh
  // deposit. anonymousXno is otherwise already either 0 or above the noise
  // floor from the check above.
  if (!prev || anonymousXno <= 0) return null;

  // Also skip anything that would render as all zeros at the user's chosen
  // decimal precision (Settings → nanodrops → "Balance & JUICED alert
  // decimal places") – there's no point announcing a JUICED alert for an
  // amount the alert itself can't actually display, and the noise floor
  // above is intentionally smaller than that so it doesn't get in the way
  // of tightening the decimal setting for a more precise faucet. Mirrors the
  // renderer's round-up-to-display-precision behavior for this figure (see
  // fmtXnoRoundedUp) – including only letting the single digit right after
  // the display precision decide the rounding, so floating-point noise
  // further out (this balance-delta math can produce something like
  // 0.5500000000000003 for what is really just 0.55) can't itself push an
  // otherwise-zero amount into being announced.
  const storedDecimals = store.get('xnoDecimals');
  const displayDecimals = Math.max(0, Math.min(8, storedDecimals != null ? Number(storedDecimals) : 2));
  const extended = anonymousXno.toFixed(displayDecimals + 1);
  const truncated = Number(extended.slice(0, -1) || '0');
  const lastDigit = extended[extended.length - 1];
  const roundedUpForDisplay = lastDigit === '0' ? truncated : Number((truncated + 1 / 10 ** displayDecimals).toFixed(displayDecimals));
  if (roundedUpForDisplay <= 0) return null;

  return {
    id: `${faucetId}:anon:${Date.now()}`,
    faucetId,
    name: null,
    text: null,
    amount: { xno: anonymousXno },
    kind: 'faucet-deposit',
    // Not shown in the alert – just so the renderer can log the underlying
    // balance-delta math to the DevTools console for troubleshooting.
    debug: debugInfo
  };
}

async function pollNanodrops({ force = false } = {}) {
  if (!store.get('showNanodrops')) return;
  const faucetIds = activeNanodropsFaucetIds();
  if (faucetIds.length === 0) {
    sendToRenderer('nanodrops-status', { ok: false, message: 'No faucet ID set' });
    return;
  }
  // The previous poll is still running (slow network) – skip this tick rather
  // than let two overlap. `force` (used when settings change) starts a new
  // poll regardless and abandons the old one.
  if (nanodropsActivePoll && !force) return;
  const token = {};
  nanodropsActivePoll = token;

  try {
    const results = await Promise.allSettled([
      ...faucetIds.map((id) => fetchFaucet(id)),
      fetchNanodropsStats()
    ]);
    // Settings changed while this was in flight: what came back is for the old
    // configuration, so drop it on the floor.
    if (nanodropsActivePoll !== token) return;

    const faucets = faucetIds.map((id, i) => ({
      id,
      src: recordNanodropsResult(`faucet:${id}`, results[i], (v) => extractFaucetData(v, id))
    }));
    const statsSrc = recordNanodropsResult('stats', results[faucetIds.length], extractStats);
    const stats = statsSrc.data;

    // Only faucets fetched *this* poll contribute messages, drops and
    // anonymous-deposit checks. A faucet that failed this time is still shown
    // via its last good stats below, but its history isn't re-fed to the
    // balance-delta logic.
    const fresh = faucets.filter(({ src }) => src.fresh);
    const anonDeposits = fresh.map(({ id, src }) => computeAnonymousDeposit(id, src.data)).filter(Boolean);

    // Everything below works off whatever data each faucet currently has: this
    // poll's, or (for up to NANODROPS_MAX_STALE_POLLS failures) its last good.
    const faucetData = faucets.map(({ src }) => src.data).filter(Boolean);

    // Faucet balance: only faucets whose stream is currently online count.
    // If a faucet is offline, its balance is left out entirely – if the
    // other one is online, only that one's balance shows; if both are
    // offline, no balance is shown. If both are online, show whichever
    // balance is bigger rather than combining them. A faucet with no
    // `online` status reported (null) is treated as online, so this
    // doesn't hide balances for setups where that field isn't present.
    const onlineFaucets = faucetData.filter((d) => d.online !== false);
    const balanceValues = onlineFaucets.map((d) => d.balanceXno).filter((v) => v != null);
    const faucetBalanceXno = balanceValues.length ? Math.max(...balanceValues.map(Number)) : null;

    const failing = [
      ...faucets.map(({ src }, i) => ({ label: faucetIds.length > 1 ? `faucet ${i + 1}` : 'faucet', src })),
      { label: 'stats', src: statsSrc }
    ].filter(({ src }) => src.failures > 0);

    // Nothing usable at all (every source down for too long) – this is the
    // only case that blanks the stats line.
    if (faucetData.length === 0 && !stats) {
      sendToRenderer('nanodrops-status', {
        ok: false,
        message: failing.length ? failing[0].src.error : 'No data'
      });
      return;
    }

    sendToRenderer('nanodrops-data', {
      faucetBalanceXno,
      // Every faucet's own balance/online status, so the overlay can show one
      // chip per platform instead of just the larger of the two.
      faucets: faucets
        .filter(({ src }) => src.data)
        .map(({ id, src }) => ({ id, balanceXno: src.data.balanceXno, online: src.data.online, watchers: src.data.watchers })),
      hourlyRateUsd: stats ? stats.hourlyRateUsd : null,
      networkActiveUsers: stats ? stats.activeUsers : null,
      networkActiveNanoXno: stats ? stats.activeNanoXno : null,
      // Which faucets this payload carries fresh history for – including ones
      // whose history happens to be empty. The renderer uses this to know
      // when it has seen a faucet's baseline (see handleNanodropsData).
      freshFaucetIds: fresh.map(({ id }) => id),
      // TTS/faucet messages (viewers leaving a note with their drop), any
      // synthetic anonymous-deposit entries, and the raw per-drop log,
      // merged from both faucets and sorted oldest-first.
      messages: [...fresh.flatMap(({ src }) => src.data.messages), ...anonDeposits],
      drops: fresh.flatMap(({ src }) => src.data.drops).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    });

    if (failing.length) {
      // Still showing data (fresh or held over), but something's wrong – say
      // what, so a mistyped faucet ID is discoverable rather than silent.
      sendToRenderer('nanodrops-status', {
        ok: true,
        warn: true,
        message: `Connected – ${failing.map(({ label, src }) => `${label}: ${src.error}`).join('; ')}`
      });
    } else {
      sendToRenderer('nanodrops-status', {
        ok: true,
        message: faucetIds.length > 1 ? 'Connected (2 faucets)' : 'Connected'
      });
    }
  } catch (err) {
    sendToRenderer('nanodrops-status', { ok: false, message: err.message });
  } finally {
    if (nanodropsActivePoll === token) nanodropsActivePoll = null;
  }
}

function startNanodropsPolling() {
  clearInterval(nanodropsTimer);
  pollNanodrops({ force: true });
  nanodropsTimer = setInterval(() => pollNanodrops(), 5000);
}

// ---------------------------------------------------------------------------
// Window position safety. The saved position was previously used as-is, so
// unplugging the monitor the overlay last lived on (or a resolution/layout
// change) left the frameless window opening entirely off-screen with no way
// to grab it.
// ---------------------------------------------------------------------------

const DRAG_STRIP_HEIGHT = 26; // matches #drag-strip in style.css
const MIN_VISIBLE_STRIP_WIDTH = 80;
const MIN_VISIBLE_STRIP_HEIGHT = 20;

// The window counts as reachable if enough of its top drag strip is showing on
// some connected display for the user to be able to grab it.
function isWindowReachable(b) {
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return false;
  return screen.getAllDisplays().some((d) => {
    const w = Math.min(b.x + b.width, d.bounds.x + d.bounds.width) - Math.max(b.x, d.bounds.x);
    const h = Math.min(b.y + DRAG_STRIP_HEIGHT, d.bounds.y + d.bounds.height) - Math.max(b.y, d.bounds.y);
    return w >= MIN_VISIBLE_STRIP_WIDTH && h >= MIN_VISIBLE_STRIP_HEIGHT;
  });
}

// Same size (shrunk if it's bigger than the screen), centred on the primary display.
function recenterOnPrimary(b) {
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(b.width, wa.width);
  const height = Math.min(b.height, wa.height);
  return {
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2),
    width,
    height
  };
}

// Startup: keep the saved position if it's still reachable, otherwise fall
// back to the primary display. A first run (no saved position yet) is left
// to Electron's default placement. Nothing is written back here, so if the
// saved monitor is just temporarily off/asleep, the saved spot survives until
// the user actually moves the window.
function fitBoundsToDisplays(saved) {
  const b = { ...saved };
  if (!Number.isFinite(b.width) || !Number.isFinite(b.height)) {
    b.width = 480;
    b.height = 640;
  }
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return { width: b.width, height: b.height };
  return isWindowReachable(b) ? b : recenterOnPrimary(b);
}

function ensureWindowOnScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const b = mainWindow.getBounds();
  if (!isWindowReachable(b)) mainWindow.setBounds(recenterOnPrimary(b));
}

function showAndFocusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  ensureWindowOnScreen();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Bounds used to be written to disk on every single move/resize event (dozens
// per second while dragging). Now they're saved once the window has been still
// for a moment, and flushed straight away when it closes or the app quits.
const BOUNDS_SAVE_DELAY_MS = 500;
let boundsSaveTimer = null;

function flushWindowBounds() {
  if (boundsSaveTimer === null) return;
  clearTimeout(boundsSaveTimer);
  boundsSaveTimer = null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  store.set('windowBounds', mainWindow.getBounds());
}

function scheduleWindowBoundsSave() {
  clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(flushWindowBounds, BOUNDS_SAVE_DELAY_MS);
}

function createWindow() {
  const bounds = fitBoundsToDisplays(store.get('windowBounds'));

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

  mainWindow.on('resize', scheduleWindowBoundsSave);
  mainWindow.on('move', scheduleWindowBoundsSave);
  mainWindow.on('close', flushWindowBounds);

  // Ctrl+Shift+I toggles DevTools – there's no menu bar (frameless window) to
  // reveal it from otherwise, and it's handy for checking console.debug
  // output. Handled here, per window, so it only fires while the overlay
  // itself has keyboard focus and never touches other apps. (While the overlay
  // is locked/click-through it can't take focus – use the tray icon's
  // "Developer Tools" entry then.) preventDefault also stops Electron's
  // default menu accelerator from toggling it a second time.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' && input.control && input.shift && !input.alt && !input.meta &&
      String(input.key).toLowerCase() === 'i'
    ) {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// globalShortcut.register() *throws* (rather than returning false) when handed
// an accelerator string Electron can't parse – e.g. a bare "+", or a key name
// it doesn't know. That used to propagate all the way back to the settings
// panel and leave the rebind button stuck on "Press a key combination…".
// This wraps it so the outcome is always one of:
//   { ok: true }                 – registered
//   { ok: false, invalid: false } – valid, but already taken by something else
//   { ok: false, invalid: true }  – not an accelerator Electron understands
function tryRegisterShortcut(accelerator, handler) {
  try {
    return { ok: !!globalShortcut.register(accelerator, handler), invalid: false };
  } catch (err) {
    console.warn(`[shortcut] could not register "${accelerator}":`, err && err.message);
    return { ok: false, invalid: true };
  }
}

// Tries to register `accelerator` for the lock/click-through toggle. On
// success, unregisters whatever was previously bound and adopts the new one.
// On failure (already in use by the OS/another app, or not a valid
// accelerator), leaves the existing binding untouched and reports why so the
// caller can say so.
function applyLockShortcut(accelerator) {
  if (currentLockAccelerator === accelerator) return { ok: true, invalid: false };
  const result = tryRegisterShortcut(accelerator, () => setClickThrough(!locked));
  if (!result.ok) return result;
  if (currentLockAccelerator) globalShortcut.unregister(currentLockAccelerator);
  currentLockAccelerator = accelerator;
  return result;
}

// Tries to register `accelerator` for the clear-chat action. Same
// register-then-swap approach as applyLockShortcut above, and supports a
// bare single key (e.g. "F21") with no modifiers, not just combinations.
function applyClearChatShortcut(accelerator) {
  if (currentClearChatAccelerator === accelerator) return { ok: true, invalid: false };
  const result = tryRegisterShortcut(accelerator, () => sendToRenderer('clear-chat'));
  if (!result.ok) return result;
  if (currentClearChatAccelerator) globalShortcut.unregister(currentClearChatAccelerator);
  currentClearChatAccelerator = accelerator;
  return result;
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
      click: () => showAndFocusWindow()
    },
    {
      label: 'Open Settings',
      click: () => {
        if (mainWindow) {
          ensureWindowOnScreen();
          mainWindow.show();
          mainWindow.webContents.send('open-settings');
        }
      }
    },
    {
      label: 'Developer Tools',
      click: () => {
        if (mainWindow) mainWindow.webContents.toggleDevTools();
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
  tray.on('click', () => showAndFocusWindow());
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return; // this is the duplicate launch – it's already quitting
  createWindow();
  createTray();
  connectStreamlabs();
  startNanodropsPolling();

  // Toggles click-through so you can lock the overlay over a game then get
  // your mouse back without alt-tabbing. Rebindable from Settings; falls
  // back to the default if the saved accelerator can't be registered
  // (e.g. another app already grabbed it).
  if (!applyLockShortcut(store.get('lockShortcut')).ok) {
    applyLockShortcut('Control+Shift+L');
  }
  // Rebindable from Settings; falls back to the default (F21) if the saved
  // key can't be registered.
  if (!applyClearChatShortcut(store.get('clearChatShortcut')).ok) {
    applyClearChatShortcut('F21');
  }
  // (DevTools' Ctrl+Shift+I is handled per-window in createWindow() – it used
  // to be a *global* shortcut here, which stole that combo from every other
  // app on the machine, including DevTools in Chrome, Edge and Discord.)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// A second launch lands here in the copy that's already running: bring the
// existing overlay forward (and back on-screen, if need be) instead.
app.on('second-instance', () => showAndFocusWindow());

app.on('before-quit', flushWindowBounds);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC ----
ipcMain.handle('get-settings', () => store.store);

ipcMain.handle('renderer-ready', () => {
  REPLAYABLE_CHANNELS.forEach((channel) => {
    if (channel in lastSent && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, lastSent[channel]);
    }
  });
});

ipcMain.handle('set-settings', (event, patch) => {
  const tokenChanged = 'streamlabsToken' in patch && patch.streamlabsToken !== store.get('streamlabsToken');
  store.set(patch);
  if (tokenChanged) connectStreamlabs();
  if ('nanodropsFaucetId' in patch || 'nanodropsFaucetId2' in patch || 'showNanodrops' in patch) {
    pruneNanodropsState();
    pollNanodrops({ force: true });
  }
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
  const { ok, invalid } = applyLockShortcut(accelerator);
  if (ok) store.set('lockShortcut', accelerator);
  return { ok, invalid, accelerator: currentLockAccelerator };
});

ipcMain.handle('set-clear-chat-shortcut', (event, accelerator) => {
  const { ok, invalid } = applyClearChatShortcut(accelerator);
  if (ok) store.set('clearChatShortcut', accelerator);
  return { ok, invalid, accelerator: currentClearChatAccelerator };
});

ipcMain.handle('quit-app', () => app.quit());
