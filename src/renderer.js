/* global overlay */

const feedEl = document.getElementById('feed');
const settingsPanel = document.getElementById('settings-panel');
const dragStripEl = document.getElementById('drag-strip');
const MAX_LINES = 300;

let settings = {};
let kickSocket = null;
let kickReconnectTimer = null;

// ---------------------------------------------------------------------------
// Startup loading indicator (next to the clock, until everything relevant
// has reported in at least once)
// ---------------------------------------------------------------------------

let pendingLoads = new Set();

function updateLoadingIndicator() {
  const el = document.getElementById('startup-loading');
  if (el) el.classList.toggle('hidden', pendingLoads.size === 0);
}

function markLoadDone(name) {
  if (!pendingLoads.has(name)) return;
  pendingLoads.delete(name);
  updateLoadingIndicator();
}

// ---------------------------------------------------------------------------
// Feed rendering
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Kick chat content encodes emotes inline as "[emote:<id>:<name>]" rather than
// sending a separate emotes array, so they have to be pulled out of the text
// and swapped for <img> tags. Everything else still gets escaped normally.
const EMOTE_RE = /\[emote:(\d+):([^\]]+)\]/g;

function renderChatContent(content) {
  const text = String(content ?? '');
  let out = '';
  let lastIndex = 0;
  let match;

  EMOTE_RE.lastIndex = 0;
  while ((match = EMOTE_RE.exec(text)) !== null) {
    out += escapeHtml(text.slice(lastIndex, match.index));
    const [, id, name] = match;
    out += `<img class="kick-emote" src="https://files.kick.com/emotes/${escapeHtml(id)}/fullsize" alt=":${escapeHtml(name)}:" title="${escapeHtml(name)}" loading="lazy" />`;
    lastIndex = match.index + match[0].length;
  }
  out += escapeHtml(text.slice(lastIndex));
  return out;
}

// `meta` (chat lines only) records who/what a line came from – platform,
// message id, user id and name(s) – so it can be taken back out of the feed if
// the message is later deleted or its author is banned/timed out.
function addLine(type, html, meta) {
  const wasNearBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;

  const div = document.createElement('div');
  div.className = `line ${type}`;
  div.dataset.ts = Date.now(); // used by clearFeed()'s new-message grace period
  if (meta) {
    if (meta.plat) div.dataset.plat = meta.plat;
    if (meta.msgId != null && meta.msgId !== '') div.dataset.msg = String(meta.msgId);
    if (meta.userId != null && meta.userId !== '') div.dataset.user = String(meta.userId);
    const names = (meta.names || []).filter(Boolean).map((n) => String(n).toLowerCase());
    if (names.length) div.dataset.names = names.join('|');
  }
  div.innerHTML = html;
  feedEl.appendChild(div);

  while (feedEl.children.length > MAX_LINES) {
    feedEl.removeChild(feedEl.firstChild);
  }

  if (wasNearBottom) feedEl.scrollTop = feedEl.scrollHeight;
}

// Takes chat lines back out of the feed after a moderation action on that
// platform: a single deleted message (matched by message id), or everything a
// banned/timed-out user said (matched by user id, or by name as a fallback for
// when a platform's event doesn't carry an id). Only chat lines are touched –
// alerts stay put.
function removeChatLines(plat, { msgId, userId, names } = {}) {
  const wantedNames = (names || []).filter(Boolean).map((n) => String(n).toLowerCase());
  Array.from(feedEl.children).forEach((el) => {
    if (!el.classList.contains('chat') || el.dataset.plat !== plat) return;
    const lineNames = el.dataset.names ? el.dataset.names.split('|') : [];
    const hit =
      (msgId != null && msgId !== '' && el.dataset.msg === String(msgId)) ||
      (userId != null && userId !== '' && el.dataset.user === String(userId)) ||
      (wantedNames.length > 0 && lineNames.some((n) => wantedNames.includes(n)));
    if (hit) feedEl.removeChild(el);
  });
}

// Clearing the feed spares any line that arrived more recently than the
// configured grace period, so a message that just landed right before the
// clear bind was pressed doesn't get wiped out along with everything else.
const DEFAULT_CLEAR_CHAT_GRACE_MS = 3000;

function clearFeed() {
  const graceMs = settings.clearChatGraceMs != null ? settings.clearChatGraceMs : DEFAULT_CLEAR_CHAT_GRACE_MS;
  const cutoff = Date.now() - graceMs;
  Array.from(feedEl.children).forEach((el) => {
    const ts = Number(el.dataset.ts || 0);
    if (ts < cutoff) feedEl.removeChild(el);
  });
}

// ---------------------------------------------------------------------------
// Settings: load, apply, save
// ---------------------------------------------------------------------------

function applyAppearance(s) {
  document.documentElement.style.setProperty('--font-size', `${s.fontSize}px`);
  document.documentElement.style.setProperty('--bg-opacity', s.bgOpacity);
  document.documentElement.style.setProperty('--drag-bar-opacity', s.dragBarOpacity != null ? s.dragBarOpacity : 0.35);
}

function populateSettingsForm(s) {
  document.getElementById('in-kick-channel').value = s.kickChannel || '';
  document.getElementById('in-kick-chatroom').value = s.kickChatroomId || '';
  document.getElementById('chk-twitch').checked = !!s.showTwitchChat;
  document.getElementById('in-twitch-channel').value = s.twitchChannel || '';
  document.getElementById('chk-kick-platform-color').checked = !!s.kickForcePlatformColor;
  document.getElementById('chk-twitch-platform-color').checked = !!s.twitchForcePlatformColor;
  document.getElementById('in-streamlabs-token').value = s.streamlabsToken || '';
  document.getElementById('chk-chat').checked = !!s.showChat;
  document.getElementById('chk-follows').checked = !!s.showFollows;
  document.getElementById('chk-subs').checked = !!s.showSubs;
  document.getElementById('chk-gifted').checked = !!s.showGiftedSubs;
  document.getElementById('chk-tips').checked = !!s.showTips;
  document.getElementById('chk-bits').checked = !!s.showBits;
  document.getElementById('chk-raids').checked = !!s.showRaids;
  document.getElementById('chk-viewers').checked = !!s.showViewerCount;
  document.getElementById('chk-kick-timer').checked = s.showKickTimer !== false;
  document.getElementById('chk-twitch-timer').checked = s.showTwitchTimer !== false;
  document.getElementById('chk-nanodrops').checked = !!s.showNanodrops;
  document.getElementById('in-nanodrops-faucet').value = s.nanodropsFaucetId || '';
  document.getElementById('in-nanodrops-faucet-2').value = s.nanodropsFaucetId2 || '';
  document.getElementById('in-drop-decimals').value = s.dropDecimals != null ? s.dropDecimals : 4;
  document.getElementById('in-xno-decimals').value = s.xnoDecimals != null ? s.xnoDecimals : 2;
  document.getElementById('chk-obs').checked = !!s.obsEnabled;
  document.getElementById('in-obs-host').value = s.obsWsHost || '';
  document.getElementById('in-obs-port').value = s.obsWsPort || '';
  document.getElementById('in-obs-password').value = s.obsWsPassword || '';
  document.getElementById('in-obs-mic').value = s.obsMicSource || '';
  document.getElementById('in-obs-desktop').value = s.obsDesktopSource || '';
  document.getElementById('in-obs-webcam').value = s.obsWebcamSource || '';
  document.getElementById('in-font-size').value = s.fontSize;
  document.getElementById('in-bg-opacity').value = s.bgOpacity;
  document.getElementById('in-drag-bar-opacity').value = s.dragBarOpacity != null ? s.dragBarOpacity : 0.35;
  document.getElementById('btn-rebind-lock').textContent = s.lockShortcut || 'Control+Shift+L';
  document.getElementById('lock-shortcut-status').textContent = '';
  document.getElementById('btn-rebind-clear-chat').textContent = s.clearChatShortcut || 'F21';
  document.getElementById('clear-chat-shortcut-status').textContent = '';
  document.getElementById('in-clear-grace').value =
    (s.clearChatGraceMs != null ? s.clearChatGraceMs : DEFAULT_CLEAR_CHAT_GRACE_MS) / 1000;
}

async function loadSettings() {
  settings = await overlay.getSettings();
  applyAppearance(settings);
  populateSettingsForm(settings);
  return settings;
}

// ---------------------------------------------------------------------------
// Kick chat – public Pusher websocket, no auth required.
// Docs: unofficial, but stable in practice (see kick-api / KickLib projects).
// ---------------------------------------------------------------------------

const KICK_PUSHER_URL =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';

// Brand colors used when the "force platform color" settings are on, and as
// the fallback when a chatter has no color of their own to show.
const KICK_BRAND_GREEN = '#53FC18';
const TWITCH_BRAND_PURPLE = '#9146FF';
const DEFAULT_CHAT_COLOR = '#E0DCCF';

// Badge types Kick sends on sender.identity.badges. Unknown/future types
// (e.g. staff, sub_gifter, trusted_user) are silently skipped rather than
// showing a broken icon.
const BADGE_ICONS = {
  broadcaster: 'icon-badge-broadcaster',
  moderator: 'icon-badge-moderator',
  vip: 'icon-badge-vip',
  og: 'icon-badge-og',
  founder: 'icon-badge-founder',
  subscriber: 'icon-badge-subscriber',
  verified: 'icon-badge-verified'
};

function renderBadges(badges) {
  if (!Array.isArray(badges) || badges.length === 0) return '';
  const icons = badges
    .map((b) => BADGE_ICONS[b && b.type])
    .filter(Boolean)
    .map((id) => {
      const type = id.replace('icon-badge-', '');
      // Tries a local badge image first (assets/badges/<type>.png, dropped in
      // by the user); falls back to the built-in drawn icon if it's missing.
      return `<span class="badge-icon-wrap">` +
        `<img class="badge-img" src="../assets/badges/${type}.png" alt="" ` +
        `onerror="this.style.display='none';this.nextElementSibling.style.display='inline-block';" />` +
        `<svg class="badge-icon ${id} badge-fallback" width="13" height="13" fill="currentColor"><use href="#${id}"></use></svg>` +
        `</span>`;
    })
    .join('');
  return icons ? `<span class="badges">${icons}</span>` : '';
}

function setKickStatus(text, cls) {
  const el = document.getElementById('kick-status');
  if (el) {
    el.textContent = text;
    el.className = `status ${cls || ''}`.trim();
  }
}

async function resolveChatroomId(slug) {
  const data = await fetchKickChannelInfo(slug);
  if (!data || !data.chatroom || !data.chatroom.id) throw new Error('No chatroom in response');
  return data.chatroom.id;
}

// Two things fetch this at launch at the same moment (chatroom-ID auto-detect
// and the live/viewer status poll) – shared here so they share one request
// instead of firing an identical duplicate.
let kickChannelInfoInFlight = null; // { slug, promise } | null

// Without a deadline, one request that hangs (half-open connection after a
// Wi-Fi drop or sleep/wake) never settles – and because callers share the
// in-flight promise, every later poll for that channel would wait on it too,
// freezing the live indicator and viewer count until restart.
const STATUS_FETCH_TIMEOUT_MS = 10000;

async function fetchKickChannelInfo(slug) {
  const clean = slug.trim().toLowerCase();
  if (kickChannelInfoInFlight && kickChannelInfoInFlight.slug === clean) {
    return kickChannelInfoInFlight.promise;
  }
  const promise = (async () => {
    const get = (s) => fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(s)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(STATUS_FETCH_TIMEOUT_MS)
    });
    let res = await get(clean);
    // Kick's channel slugs use hyphens where usernames have underscores
    // ("Foo_Bar" -> "foo-bar"). Only tried as a fallback, so a name that
    // already works as typed is never affected.
    if (res.status === 404 && clean.includes('_')) res = await get(clean.replace(/_/g, '-'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })();
  const entry = { slug: clean, promise };
  kickChannelInfoInFlight = entry;
  try {
    return await promise;
  } finally {
    if (kickChannelInfoInFlight === entry) kickChannelInfoInFlight = null;
  }
}

// Same silent-drop protection as Twitch (see the watchdog notes there): a
// connection can die without the browser ever firing "close" (sleep/wake,
// Wi-Fi drop), leaving the status on "Connected" while chat sits frozen. Pusher
// has a keep-alive for exactly this – if nothing has arrived for its
// activity_timeout, the client pings, and the connection is treated as dead if
// even that goes unanswered.
const KICK_WATCHDOG_TICK_MS = 10000;
const KICK_DEFAULT_ACTIVITY_TIMEOUT_MS = 120000;
const KICK_PONG_TIMEOUT_MS = 30000;

let kickWatchdogTimer = null;
let kickLastActivity = 0;
let kickActivityTimeoutMs = KICK_DEFAULT_ACTIVITY_TIMEOUT_MS;

// Fully retires the current Kick connection. Handlers are detached *before*
// closing: a closing socket's async "close" event would otherwise schedule a
// reconnect that kills the replacement connection (see teardownTwitchSocket).
function teardownKickSocket() {
  clearTimeout(kickReconnectTimer);
  clearInterval(kickWatchdogTimer);
  const old = kickSocket;
  kickSocket = null;
  if (old) {
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try { old.close(); } catch (_) { /* noop */ }
  }
}

// Kick's event payloads arrive as a JSON string in envelope.data.
function parseKickEventData(envelope) {
  try {
    const data = typeof envelope.data === 'string' ? JSON.parse(envelope.data) : envelope.data;
    return data || {};
  } catch (_) {
    return null;
  }
}

function connectKickChat(chatroomId) {
  teardownKickSocket();

  if (!chatroomId) {
    setKickStatus('No chatroom configured', 'err');
    return;
  }

  setKickStatus('Connecting to chat…');
  // Handlers close over this specific socket (ws), not the shared kickSocket
  // variable, so a stale socket can never act for the live one.
  const ws = new WebSocket(KICK_PUSHER_URL);
  kickSocket = ws;
  kickLastActivity = Date.now();
  kickActivityTimeoutMs = KICK_DEFAULT_ACTIVITY_TIMEOUT_MS;

  ws.onmessage = (raw) => {
    if (kickSocket !== ws) return;
    kickLastActivity = Date.now();

    let envelope;
    try {
      envelope = JSON.parse(raw.data);
    } catch (_) {
      return;
    }

    // Pusher's own keep-alive: the server pings, and the client is expected to
    // pong (standard Pusher clients all do). Never answering it risks the
    // server eventually dropping an otherwise-healthy connection.
    if (envelope.event === 'pusher:ping') {
      try { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); } catch (_) { /* onclose will handle it */ }
      return;
    }

    if (envelope.event === 'pusher:connection_established') {
      // The server says how long it's happy to wait between messages.
      const info = parseKickEventData(envelope);
      const serverTimeoutSec = info && Number(info.activity_timeout);
      if (serverTimeoutSec > 0) {
        kickActivityTimeoutMs = Math.max(15000, Math.min(KICK_DEFAULT_ACTIVITY_TIMEOUT_MS, serverTimeoutSec * 1000));
      }
      ws.send(JSON.stringify({
        event: 'pusher:subscribe',
        data: { auth: '', channel: `chatrooms.${chatroomId}.v2` }
      }));
      setKickStatus('Connected');
      return;
    }

    if (envelope.event === 'App\\Events\\ChatMessageEvent') {
      const payload = parseKickEventData(envelope);
      if (!payload) return;
      if (!settings.showChat) return;

      const sender = payload.sender || {};
      const color = settings.kickForcePlatformColor
        ? KICK_BRAND_GREEN
        : (sender.identity && sender.identity.color) || DEFAULT_CHAT_COLOR;
      const badges = (sender.identity && sender.identity.badges) || [];
      addLine('chat',
        `<span class="user" style="color:${escapeHtml(color)}">${renderBadges(badges)}${escapeHtml(sender.username)}</span>: ` +
        `<span class="msg">${renderChatContent(payload.content)}</span>`,
        { plat: 'kick', msgId: payload.id, userId: sender.id, names: [sender.username, sender.slug] }
      );
      return;
    }

    // A moderator (or automod) deleted a message. Field names are from
    // Kick's undocumented socket – the raw payload is logged to the DevTools
    // console so they can be checked against a real one.
    if (envelope.event === 'App\\Events\\MessageDeletedEvent') {
      const payload = parseKickEventData(envelope);
      console.debug('[kick] message deleted event', payload);
      if (!payload) return;
      const msgId = (payload.message && payload.message.id) || payload.message_id;
      if (msgId) removeChatLines('kick', { msgId });
      return;
    }

    // A ban or timeout (same event; a timeout just isn't "permanent"). Same
    // caveat as above about the field names – logged for checking.
    if (envelope.event === 'App\\Events\\UserBannedEvent') {
      const payload = parseKickEventData(envelope);
      console.debug('[kick] user banned/timed-out event', payload);
      if (!payload) return;
      const user = payload.user || {};
      if (user.id != null || user.username || user.slug) {
        removeChatLines('kick', { userId: user.id, names: [user.username, user.slug] });
      }
      return;
    }

    // Kick raids/hosts. Kick's official API has no raid event, but its chat
    // socket has carried an undocumented "StreamHostEvent" – field names below
    // are best guesses with fallbacks, and the raw payload is always logged
    // (DevTools console) so they can be corrected against a real one.
    if (envelope.event === 'App\\Events\\StreamHostEvent') {
      let payload;
      try { payload = typeof envelope.data === 'string' ? JSON.parse(envelope.data) : envelope.data; } catch (_) { return; }
      payload = payload || {};
      console.debug('[kick] raid/host event', payload);
      const host = payload.host_username || payload.hostUsername || payload.username ||
        (payload.host && (payload.host.username || payload.host.name)) || payload.name;
      const viewers = payload.number_viewers ?? payload.numberViewers ?? payload.viewers ?? payload.viewer_count ?? payload.count;
      showRaid('plat-kick', host, viewers);
      return;
    }

    // Anything else (pins, mode changes, and any undocumented gift-related
    // events that occasionally ride the same socket) is logged rather than shown,
    // since alerts are handled through Streamlabs instead. Useful if you want to
    // inspect what Kick actually sends here.
    if (envelope.event && envelope.event.startsWith('App\\Events\\')) {
      console.debug('[kick] unhandled event', envelope.event, envelope.data);
    }
  };

  ws.onclose = () => {
    if (kickSocket !== ws) return; // a retired socket closing – nothing to do
    clearInterval(kickWatchdogTimer);
    setKickStatus('Disconnected, retrying…', 'err');
    kickReconnectTimer = setTimeout(() => connectKickChat(chatroomId), 4000);
  };

  ws.onerror = () => {
    // onclose will fire right after; the reconnect is handled there.
  };

  kickWatchdogTimer = setInterval(() => {
    if (kickSocket !== ws || ws.readyState !== WebSocket.OPEN) return;
    const idle = Date.now() - kickLastActivity;
    if (idle > kickActivityTimeoutMs + KICK_PONG_TIMEOUT_MS) {
      console.warn('[kick] connection went silent – reconnecting');
      setKickStatus('Disconnected, retrying…', 'err');
      connectKickChat(chatroomId);
    } else if (idle > kickActivityTimeoutMs) {
      try { ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch (_) { /* onclose will handle it */ }
    }
  }, KICK_WATCHDOG_TICK_MS);
}

async function startKickChat() {
  if (settings.kickChatroomId) {
    connectKickChat(settings.kickChatroomId.trim());
    return;
  }
  if (!settings.kickChannel) {
    setKickStatus('No channel set – open settings');
    return;
  }
  setKickStatus('Looking up chatroom…');
  try {
    const id = await resolveChatroomId(settings.kickChannel);
    connectKickChat(id);
  } catch (err) {
    setKickStatus(`Auto-detect failed (${err.message}) – enter Chatroom ID manually`, 'err');
  }
}

// ---------------------------------------------------------------------------
// Twitch chat – anonymous, read-only IRC-over-WebSocket. No OAuth/login
// needed to read public chat. Runs alongside Kick chat (not instead of it).
// Docs: https://dev.twitch.tv/docs/irc/
// ---------------------------------------------------------------------------

const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

let twitchSocket = null;
let twitchReconnectTimer = null;
let twitchWatchdogTimer = null;
let twitchLastActivity = 0;

// Twitch normally sends a PING every few minutes, but a connection can also
// die silently (sleep/wake, Wi-Fi drop, a NAT timing out) without the browser
// ever firing "close" – chat then just stops. So if nothing at all has arrived
// for a minute the overlay pings Twitch itself, and reconnects if that goes
// unanswered.
const TWITCH_WATCHDOG_TICK_MS = 15000;
const TWITCH_IDLE_PING_MS = 60000;
const TWITCH_PONG_TIMEOUT_MS = 15000;

// Fully retires the current Twitch connection. The old socket's handlers are
// detached *before* closing it, because a socket's "close" event fires
// asynchronously – left attached, it would schedule a reconnect that then
// kills the brand-new connection, which schedules another, and so on forever
// (the connected/disconnected flicker every ~4 seconds).
function teardownTwitchSocket() {
  clearTimeout(twitchReconnectTimer);
  clearInterval(twitchWatchdogTimer);
  const old = twitchSocket;
  twitchSocket = null;
  if (old) {
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try { old.close(); } catch (_) { /* noop */ }
  }
}

function setTwitchStatus(text, cls) {
  const el = document.getElementById('twitch-status');
  if (el) {
    el.textContent = text;
    el.className = `status ${cls || ''}`.trim();
  }
}

// Minimal IRC line parser – just enough for PRIVMSG/PING/NOTICE/JOIN with
// IRCv3 tags. Twitch messages look like:
//   @badges=moderator/1;color=#FF0000;display-name=Foo;emotes=... :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hello world
function parseIrcLine(raw) {
  let rest = raw;
  const tags = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    rest.slice(1, sp).split(';').forEach((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return;
      tags[pair.slice(0, eq)] = pair.slice(eq + 1);
    });
    rest = rest.slice(sp + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const colonIdx = rest.indexOf(' :');
  let command, params, trailing = '';
  if (colonIdx === -1) {
    const parts = rest.trim().split(' ').filter(Boolean);
    command = parts[0];
    params = parts.slice(1);
  } else {
    const parts = rest.slice(0, colonIdx).trim().split(' ').filter(Boolean);
    command = parts[0];
    params = parts.slice(1);
    trailing = rest.slice(colonIdx + 2);
  }
  return { tags, prefix, command: command || '', params, trailing };
}

// Twitch's badges tag looks like "moderator/1,subscriber/12" – strip the
// "/<version>" suffix. Reuses the same BADGE_ICONS map as Kick (badge type
// names like "moderator"/"broadcaster"/"vip"/"subscriber"/"founder" match);
// Twitch-only types with no matching icon are silently skipped as usual.
function parseTwitchBadges(badgesTag) {
  if (!badgesTag) return [];
  return badgesTag.split(',').map((b) => ({ type: b.split('/')[0] })).filter((b) => b.type);
}

// Twitch's emotes tag gives ranges into the message text:
// "emoteId:start-end,start-end/emoteId2:start-end". Those positions count
// Unicode code points (characters), NOT JavaScript's UTF-16 string units –
// they only agree until the message contains an emoji outside the basic
// plane (😀 and friends take two JS units), after which every emote further
// along would land in the wrong place if used as string indices directly, so
// they're translated to string offsets below. Twitch's own emote CDN
// (static-cdn.jtvnw.net) is the same one every Twitch chat client hotlinks,
// official and third-party alike.
function renderTwitchChatContent(message, emotesTag) {
  const text = String(message ?? '');
  if (!emotesTag) return escapeHtml(text);

  const ranges = [];
  emotesTag.split('/').forEach((part) => {
    const [id, posList] = part.split(':');
    if (!id || !posList) return;
    posList.split(',').forEach((range) => {
      const [start, end] = range.split('-').map(Number);
      if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ id, start, end });
    });
  });
  if (ranges.length === 0) return escapeHtml(text);
  ranges.sort((a, b) => a.start - b.start);

  // offsets[i] = where code point i starts in the JS string; the extra final
  // entry is one past the end, so an emote's (end + 1) can be looked up too.
  const offsets = [];
  let unit = 0;
  for (const ch of text) {
    offsets.push(unit);
    unit += ch.length;
  }
  offsets.push(unit);
  const codePointCount = offsets.length - 1;

  let out = '';
  let lastIndex = 0; // string offset, not a code point index
  ranges.forEach(({ id, start, end }) => {
    if (end < start || end >= codePointCount) return; // bad data guard
    const from = offsets[start];
    const to = offsets[end + 1];
    if (from < lastIndex) return; // overlapping data guard
    out += escapeHtml(text.slice(lastIndex, from));
    const name = text.slice(from, to);
    out += `<img class="twitch-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/2.0" alt=":${escapeHtml(name)}:" title="${escapeHtml(name)}" loading="lazy" />`;
    lastIndex = to;
  });
  out += escapeHtml(text.slice(lastIndex));
  return out;
}

// "/me waves" arrives as an IRC CTCP ACTION: the message text is wrapped as
// "\u0001ACTION waves\u0001". Twitch's emote positions are counted against the
// text *inside* that wrapper, so it has to be peeled off before rendering –
// left on, the literal "ACTION" shows and every emote lands 8 characters off.
const TWITCH_ACTION_RE = /^\u0001ACTION(?: ([\s\S]*?))?\u0001?$/;

function connectTwitchChat(channel) {
  teardownTwitchSocket();

  const login = channel.trim().toLowerCase().replace(/^#/, '');
  if (!login) {
    setTwitchStatus('No channel set', 'err');
    markLoadDone('twitch');
    return;
  }

  setTwitchStatus('Connecting to chat…');
  // Handlers close over this specific socket (ws), not the shared
  // twitchSocket variable, so a stale socket can never act for the live one.
  const ws = new WebSocket(TWITCH_IRC_URL);
  twitchSocket = ws;
  twitchLastActivity = Date.now();

  ws.onopen = () => {
    const anonNick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send('PASS SCHMOOPIIE');
    ws.send(`NICK ${anonNick}`);
    ws.send(`JOIN #${login}`);
  };

  ws.onmessage = (raw) => {
    if (twitchSocket !== ws) return;
    twitchLastActivity = Date.now();
    // A single WebSocket frame can carry several IRC lines back to back.
    String(raw.data).split('\r\n').filter(Boolean).forEach((line) => {
      // One malformed line must not stop the rest of the frame from showing.
      try {
        const msg = parseIrcLine(line);

        if (msg.command === 'PING') {
          ws.send(`PONG :${msg.trailing || 'tmi.twitch.tv'}`);
          return;
        }

        if (msg.command === 'JOIN') {
          setTwitchStatus('Connected', 'ok');
          markLoadDone('twitch');
          return;
        }

        if (msg.command === 'NOTICE') {
          // e.g. channel suspended/doesn't exist – shown, but still retries on
          // close in case it's transient.
          setTwitchStatus(msg.trailing || 'Notice from Twitch', 'err');
          markLoadDone('twitch');
          return;
        }

        if (msg.command === 'PRIVMSG') {
          if (!settings.showChat) return;
          const nick = (msg.prefix || '').split('!')[0];
          const name = msg.tags['display-name'] || nick || 'Someone';
          // By default, Twitch names keep each chatter's own chosen chat
          // color (same behavior as Kick) – falling back to a neutral color
          // for chatters who never set one. "Force Twitch usernames to Twitch
          // purple" in settings overrides this to a single brand color instead.
          const color = settings.twitchForcePlatformColor
            ? TWITCH_BRAND_PURPLE
            : (msg.tags.color || DEFAULT_CHAT_COLOR);
          const badges = parseTwitchBadges(msg.tags.badges);
          let text = msg.trailing;
          const action = TWITCH_ACTION_RE.exec(text);
          if (action) text = action[1] || '';
          // Twitch flags a chatter's first ever message in the channel with
          // first-msg=1 (it's what drives the "First time chatter" highlight in
          // Twitch's own chat). Shown as a FIRST pill plus an accented line.
          const isFirstMsg = msg.tags['first-msg'] === '1';
          const firstTag = isFirstMsg ? '<span class="tag tag-first">FIRST</span>' : '';
          const userHtml = `${firstTag}<span class="user" style="color:${escapeHtml(color)}">${renderBadges(badges)}${escapeHtml(name)}</span>`;
          const contentHtml = renderTwitchChatContent(text, msg.tags.emotes);
          // Like Twitch's own chat, a /me line has no colon and the text is
          // in the chatter's colour: "Foo waves" rather than "Foo: waves".
          addLine(isFirstMsg ? 'chat first-msg' : 'chat',
            action
              ? `${userHtml} <span class="msg action" style="color:${escapeHtml(color)}">${contentHtml}</span>`
              : `${userHtml}: <span class="msg">${contentHtml}</span>`,
            { plat: 'twitch', msgId: msg.tags.id, userId: msg.tags['user-id'], names: [nick, name] }
          );
          return;
        }

        // A moderator deleted a single message.
        if (msg.command === 'CLEARMSG') {
          removeChatLines('twitch', { msgId: msg.tags['target-msg-id'] });
          return;
        }

        // A ban or timeout carries the target's id and name. A CLEARCHAT with
        // no target is someone running /clear on the whole chat – left alone
        // here; the overlay has its own clear-chat shortcut for that.
        if (msg.command === 'CLEARCHAT') {
          const targetId = msg.tags['target-user-id'];
          const targetName = msg.trailing;
          if (targetId || targetName) removeChatLines('twitch', { userId: targetId, names: [targetName] });
          return;
        }
      } catch (err) {
        console.error('[twitch] failed to process line:', err, line);
      }
    });
  };

  ws.onclose = () => {
    if (twitchSocket !== ws) return; // a retired socket closing – nothing to do
    clearInterval(twitchWatchdogTimer);
    markLoadDone('twitch'); // don't hang the startup indicator if Twitch is unreachable
    if (!settings.showTwitchChat) return;
    setTwitchStatus('Disconnected, retrying…', 'err');
    twitchReconnectTimer = setTimeout(() => connectTwitchChat(channel), 4000);
  };

  ws.onerror = () => {
    // onclose fires right after; reconnect is handled there.
  };

  twitchWatchdogTimer = setInterval(() => {
    if (twitchSocket !== ws || ws.readyState !== WebSocket.OPEN) return;
    const idle = Date.now() - twitchLastActivity;
    if (idle > TWITCH_IDLE_PING_MS + TWITCH_PONG_TIMEOUT_MS) {
      console.warn('[twitch] connection went silent – reconnecting');
      setTwitchStatus('Disconnected, retrying…', 'err');
      connectTwitchChat(channel);
    } else if (idle > TWITCH_IDLE_PING_MS) {
      try { ws.send('PING :tmi.twitch.tv'); } catch (_) { /* onclose will handle it */ }
    }
  }, TWITCH_WATCHDOG_TICK_MS);
}

function startTwitchChat() {
  teardownTwitchSocket();

  if (!settings.showTwitchChat) {
    setTwitchStatus('Not enabled');
    markLoadDone('twitch');
    return;
  }
  if (!settings.twitchChannel) {
    setTwitchStatus('No channel set', 'err');
    markLoadDone('twitch');
    return;
  }
  connectTwitchChat(settings.twitchChannel);
}

// ---------------------------------------------------------------------------
// Clock + stream live status/uptime (top strip)
// ---------------------------------------------------------------------------

// Live state per platform. Both can be live at once; each drives its own
// timer and viewer chip. `start` is a Date, or null when offline/unknown.
const liveState = {
  kick: { live: false, start: null },
  twitch: { live: false, start: null }
};
let lastKickStartRaw = null; // last raw start_time/created_at string from Kick, for diagnostics
let lastTwitchStartRaw = null; // last raw createdAt string from Twitch, for diagnostics

// A platform's timer shows only while it's live AND its "Display ... live
// timer" setting is on (both default to on).
function timerVisible(platform) {
  const enabled = platform === 'kick' ? settings.showKickTimer : settings.showTwitchTimer;
  return liveState[platform].live && enabled !== false;
}

function formatUptime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function tickClockAndUptime() {
  const kickTimer = timerVisible('kick');
  const twitchTimer = timerVisible('twitch');

  const clockEl = document.getElementById('clock-time');
  // Drop the seconds from the clock while a live timer is showing its own
  // running seconds counter, so there's only one seconds-ticking number in
  // the strip at a time. No explicit locale passed, so this still follows
  // the OS's own clock format (12h/24h, separators, etc.) either way.
  if (clockEl) {
    clockEl.textContent = (kickTimer || twitchTimer)
      ? new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : new Date().toLocaleTimeString();
  }

  [
    { key: 'kick', name: 'Kick', visible: kickTimer, raw: lastKickStartRaw },
    { key: 'twitch', name: 'Twitch', visible: twitchTimer, raw: lastTwitchStartRaw }
  ].forEach(({ key, name, visible, raw }) => {
    const indicatorEl = document.getElementById(`stream-live-${key}`);
    if (indicatorEl) indicatorEl.classList.toggle('hidden', !visible);
    const uptimeEl = document.getElementById(`stream-uptime-${key}`);
    if (!uptimeEl || !visible) return;
    const start = liveState[key].start;
    uptimeEl.textContent = start ? formatUptime(Date.now() - start.getTime()) : '00:00';
    // Hover the uptime to see exactly what the live platform sent us and how
    // we read it - the quickest way to tell a platform-side start-time issue
    // apart from a parsing bug on our end.
    uptimeEl.title = start
      ? `${name} sent: ${raw}\nRead as (UTC): ${start.toISOString()}\nYour local time: ${start.toString()}`
      : '';
  });
}

setInterval(tickClockAndUptime, 1000);
tickClockAndUptime();

// ---------------------------------------------------------------------------
// Live viewer count + live/uptime status (single poll, same Kick endpoint
// used for chatroom lookup)
// ---------------------------------------------------------------------------

let viewerPollTimer = null;

function fmtViewers(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

// Kick's API returns livestream timestamps (start_time / created_at) as UTC
// but without a 'Z' or offset suffix, e.g. "2026-09-13 12:39:00". Handed to
// `new Date()` as-is, a string like that gets parsed as *local* time, which
// silently shifts it by the viewer's UTC offset (an extra hour of "uptime"
// during British Summer Time, for example). Normalize to ISO 8601 with an
// explicit Z so it's always read as UTC, unless it already carries a zone.
function parseKickUtcTimestamp(raw) {
  if (!raw) return null;
  const iso = String(raw).trim().replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const d = new Date(withZone);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Twitch stream status (live/viewer count) – public GQL endpoint, no
// OAuth/login needed. Uses the same Client-Id the twitch.tv web player
// itself sends for logged-out viewers; well-known and used by numerous
// open-source Twitch tools for this exact kind of read-only public query.
// ---------------------------------------------------------------------------

const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

let twitchStatusInFlight = null; // { login, promise } | null

async function fetchTwitchStreamInfo(login) {
  const clean = login.trim().toLowerCase().replace(/^#/, '');
  if (!clean) return null;
  if (twitchStatusInFlight && twitchStatusInFlight.login === clean) {
    return twitchStatusInFlight.promise;
  }
  const promise = (async () => {
    const res = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Id': TWITCH_GQL_CLIENT_ID },
      body: JSON.stringify({
        query: 'query($login: String!) { user(login: $login) { stream { id viewersCount createdAt } } }',
        variables: { login: clean }
      }),
      signal: AbortSignal.timeout(STATUS_FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const stream = json && json.data && json.data.user && json.data.user.stream;
    return {
      live: !!stream,
      viewerCount: stream && stream.viewersCount != null ? Number(stream.viewersCount) : null,
      startedAt: stream ? stream.createdAt : null // already a zoned ISO 8601 timestamp, unlike Kick's
    };
  })();
  const entry = { login: clean, promise };
  twitchStatusInFlight = entry;
  try {
    return await promise;
  } finally {
    if (twitchStatusInFlight === entry) twitchStatusInFlight = null;
  }
}

// One platform's live status reading: { live, viewers, start }.
const OFFLINE_READING = Object.freeze({ live: false, viewers: null, start: null });

// How many status checks in a row may fail before a platform is treated as
// offline. Checks are 30s apart, so a lone failure is ridden out and it takes
// ~90s of unbroken failures before the indicator gives up.
const STATUS_MAX_FAILURES = 3;
const platformStatusCache = {
  kick: { channel: null, failures: 0, last: null },
  twitch: { channel: null, failures: 0, last: null }
};

// Turns one poll's outcome into a reading. A successful poll is parsed as
// normal. A failed one repeats the previous reading (so the live indicator,
// uptime and viewer count don't flicker to "offline" on a single dropped
// request) until it has failed STATUS_MAX_FAILURES times running. The cache is
// per channel, so changing channels never carries over the old one's state.
function settlePlatformStatus(key, channel, result, parse) {
  const cache = platformStatusCache[key];
  if (cache.channel !== channel) {
    cache.channel = channel;
    cache.failures = 0;
    cache.last = null;
  }
  if (result.status === 'fulfilled') {
    cache.failures = 0;
    cache.last = result.value ? parse(result.value) : OFFLINE_READING;
    return cache.last;
  }
  cache.failures += 1;
  console.debug(`[${key}] stream status poll failed (${cache.failures} in a row)`, result.reason && result.reason.message);
  return cache.failures < STATUS_MAX_FAILURES && cache.last ? cache.last : OFFLINE_READING;
}

// Polls Kick and Twitch's live status together and decides what the drag-bar
// timers and viewer counts show. Each platform has its own timer and viewer
// chip, so when both are live at once both are shown (Kick first, in Kick
// green; Twitch second, in Twitch purple). Twitch status is tracked whenever
// a Twitch channel is configured, independent of whether Twitch chat display
// is on.
// Token of the poll currently running. Ticks never overlap (a second poll
// racing the first could count one outage's failures twice); pressing Save
// starts a fresh poll on purpose (`force`), abandoning the old one, since the
// channels may have just changed.
let statusPollActive = null;

async function pollStreamStatus({ force = false } = {}) {
  const hasKick = !!settings.kickChannel;
  const hasTwitch = !!settings.twitchChannel;

  if (!hasKick && !hasTwitch) {
    liveState.kick = { live: false, start: null };
    liveState.twitch = { live: false, start: null };
    document.getElementById('stat-viewers-kick').classList.add('hidden');
    document.getElementById('stat-viewers-twitch').classList.add('hidden');
    markLoadDone('kick');
    return;
  }

  if (statusPollActive && !force) return;
  const token = {};
  statusPollActive = token;
  try {
    await runStreamStatusPoll(token, hasKick, hasTwitch);
  } finally {
    if (statusPollActive === token) statusPollActive = null;
  }
}

async function runStreamStatusPoll(token, hasKick, hasTwitch) {
  const [kickResult, twitchResult] = await Promise.allSettled([
    hasKick ? fetchKickChannelInfo(settings.kickChannel) : Promise.resolve(null),
    hasTwitch ? fetchTwitchStreamInfo(settings.twitchChannel) : Promise.resolve(null)
  ]);
  if (statusPollActive !== token) return; // superseded while waiting

  // A check that fails outright (network blip, Kick's Cloudflare hiccup) says
  // nothing about whether the stream is live, so it keeps the previous reading
  // rather than flipping everything to "offline" (see settlePlatformStatus).
  const kick = settlePlatformStatus('kick', settings.kickChannel || '', kickResult, (info) => {
    const live = info.livestream;
    if (!live) return OFFLINE_READING;
    const startedAt = live.start_time || live.created_at;
    lastKickStartRaw = startedAt || null;
    const start = startedAt ? parseKickUtcTimestamp(startedAt) : null;
    console.debug('[kick] livestream start –', 'raw:', startedAt, '| read as UTC:', start ? start.toISOString() : null, '| now:', new Date().toISOString());
    return { live: true, viewers: live.viewer_count != null ? live.viewer_count : null, start };
  });

  const twitch = settlePlatformStatus('twitch', settings.twitchChannel || '', twitchResult, (data) => {
    if (!data.live) return OFFLINE_READING;
    lastTwitchStartRaw = data.startedAt || null;
    let start = data.startedAt ? new Date(data.startedAt) : null;
    if (start && isNaN(start.getTime())) start = null;
    return { live: true, viewers: data.viewerCount, start };
  });

  const kickLive = kick.live;
  const twitchLive = twitch.live;

  liveState.kick = { live: kickLive, start: kickLive ? kick.start : null };
  liveState.twitch = { live: twitchLive, start: twitchLive ? twitch.start : null };

  // One viewer chip per live platform (both when both are live). When neither
  // is live a single chip reads "offline" - Kick's, unless only Twitch is set up.
  const kickChip = document.getElementById('stat-viewers-kick');
  const twitchChip = document.getElementById('stat-viewers-twitch');
  if (settings.showViewerCount) {
    const anyLive = kickLive || twitchLive;
    const showKick = kickLive || (!anyLive && (hasKick || !hasTwitch));
    const showTwitch = twitchLive || (!anyLive && !showKick);
    const fill = (chip, live, viewers) => {
      document.getElementById(`${chip.id}-value`).textContent =
        live ? (viewers != null ? fmtViewers(viewers) : '–') : 'offline';
    };
    kickChip.classList.toggle('hidden', !showKick);
    twitchChip.classList.toggle('hidden', !showTwitch);
    if (showKick) fill(kickChip, kickLive, kick.viewers);
    if (showTwitch) fill(twitchChip, twitchLive, twitch.viewers);
  } else {
    kickChip.classList.add('hidden');
    twitchChip.classList.add('hidden');
  }

  markLoadDone('kick');
}

function startViewerPolling() {
  clearInterval(viewerPollTimer);
  pollStreamStatus({ force: true });
  viewerPollTimer = setInterval(() => pollStreamStatus(), 30000);
}

// ---------------------------------------------------------------------------
// Streamlabs alerts (follows, subs, gifted subs, bits, raids, tips – Kicks & PayPal alike)
// ---------------------------------------------------------------------------

function setStreamlabsStatus(status) {
  const el = document.getElementById('streamlabs-status');
  if (el) {
    el.textContent = status.message;
    el.className = `status ${status.connected ? 'ok' : ''}`.trim();
  }
}

function formatAmount(item) {
  if (item.formattedAmount) return item.formattedAmount;
  if (item.formatted_amount) return item.formatted_amount;
  if (item.amount != null) return `${item.amount}${item.currency ? ' ' + item.currency : ''}`;
  return '';
}

// Maps a Streamlabs alert's source (eventData.for / item.platform, e.g.
// "kick_account" or "twitch_account") to a CSS class that colors the alert
// line in that platform's brand color. Anything else (PayPal tips, other
// platforms) gets no class and keeps its normal per-type color.
function platformClass(source) {
  const src = String(source || '').toLowerCase();
  if (src.includes('kick')) return 'plat-kick';
  if (src.includes('twitch')) return 'plat-twitch';
  return '';
}

// Raids can reach the overlay by more than one route (Streamlabs' "raid"
// alert, and Kick's own StreamHostEvent on the chat socket), so a raid from
// the same channel within a short window is only shown once.
const recentRaids = new Map();
const RAID_DEDUPE_MS = 30000;

function showRaid(plat, rawName, rawCount) {
  if (!settings.showRaids) return;
  const key = String(rawName || '').toLowerCase();
  const now = Date.now();
  const last = recentRaids.get(key);
  if (key && last && now - last < RAID_DEDUPE_MS) return;
  if (key) recentRaids.set(key, now);
  // Keep the map from growing without bound.
  if (recentRaids.size > 50) recentRaids.delete(recentRaids.keys().next().value);

  const name = escapeHtml(rawName || 'Someone');
  const count = Number(rawCount);
  const viewers = Number.isFinite(count) && count > 0
    ? ` with <span class="amount">${count}</span> ${count === 1 ? 'viewer' : 'viewers'}`
    : '';
  addLine(plat ? `raid ${plat}` : 'raid',
    `<span class="tag">RAID</span><span class="user">${name}</span> raided${viewers}`
  );
}

function handleStreamlabsItem(type, item, source) {
  // Logged unconditionally: Streamlabs doesn't fully document how a Kicks tip
  // payload differs from a PayPal tip payload, so this is the quickest way to
  // check real field names the first time each comes in.
  console.debug('[streamlabs]', type, 'for:', source, item);

  // Twitch payloads carry both `name` (the lowercase login, "jaredstammy") and
  // `display_name` (as the user styled it, "JaredStammy") – show the latter.
  // Kick and tip payloads have no display_name, so they fall back to `name`.
  const name = escapeHtml(item.display_name || item.name || item.from || 'Someone');
  const plat = platformClass(source);
  const withPlat = (cls) => (plat ? `${cls} ${plat}` : cls);

  switch (type) {
    case 'follow':
      if (!settings.showFollows) return;
      addLine(withPlat('follow'), `<span class="tag">FOLLOW</span><span class="user">${name}</span> followed`);
      return;

    case 'subscription':
    // Kick's multi-sub gift bombs arrive under their own type strings rather
    // than the plain "subscription" used for a single (individual) gifted
    // sub, so they're funnelled into the same handling here too.
    // "communityGift" is the confirmed type string from a live payload (a
    // gifter, gifter/gifter_display_name, an amount, and the list of
    // recipients in massSubGiftChildAlerts); the others are kept as
    // fallbacks in case a differently-named variant ever turns up.
    case 'communityGift':
    case 'giftedSubscription':
    case 'giftedSubscriptions':
    case 'communityGiftSubscription':
    case 'massGiftedSubscription': {
      // A single gifted sub has a recipient (`name`) plus a `gifter`. A bulk
      // gift ("sub bomb") only has the gifter, a count of how many were
      // gifted, and – confirmed live – a massSubGiftChildAlerts array with
      // one entry per recipient.
      const recipients = Array.isArray(item.massSubGiftChildAlerts) ? item.massSubGiftChildAlerts : null;
      const rawName = item.name || item.from || 'Someone';
      const gifterRaw = item.gifter_display_name || item.gifter || item.giftedFrom;
      // A normal (non-gifted) Kick sub still populates "gifter" with the
      // subscriber's own name, so only treat it as a real gift when the
      // gifter is someone other than the subscriber – otherwise every plain
      // sub reads as "user gifted a sub to user".
      const isSelfGifter = !!(gifterRaw && String(gifterRaw).toLowerCase() === String(rawName).toLowerCase());
      const isGift = !!((recipients && recipients.length) || item.bulkGifted || item.is_gift || (gifterRaw && !isSelfGifter));
      const gifter = escapeHtml(gifterRaw || name || 'Someone');

      if (isGift && recipients && recipients.length) {
        if (!settings.showGiftedSubs) return;
        const count = Number(item.amount) || recipients.length;
        const MAX_NAMES = 8;
        const recipientNames = recipients.map((r) => escapeHtml(r.display_name || r.name || 'someone'));
        const shown = recipientNames.slice(0, MAX_NAMES).join(', ');
        const extra = recipientNames.length > MAX_NAMES ? ` +${recipientNames.length - MAX_NAMES} more` : '';
        addLine(withPlat('giftedsub'),
          `<span class="tag">GIFTED SUB</span><span class="user">${gifter}</span> gifted ` +
          `<span class="amount">${count}</span> subs to <span class="user">${shown}</span>${extra}`
        );
        return;
      }

      const bulkCount = Number(
        item.giftAmount ?? item.gift_amount ?? item.quantity ?? item.subCount ?? item.sub_count ??
        item.numGifted ?? item.num_gifted ?? ((isGift && !item.name && item.amount) ? item.amount : 0)
      ) || 0;

      if (isGift && bulkCount > 1) {
        if (!settings.showGiftedSubs) return;
        addLine(withPlat('giftedsub'),
          `<span class="tag">GIFTED SUB</span><span class="user">${gifter}</span> gifted ` +
          `<span class="amount">${bulkCount}</span> subs`
        );
      } else if (isGift) {
        if (!settings.showGiftedSubs) return;
        addLine(withPlat('giftedsub'),
          `<span class="tag">GIFTED SUB</span><span class="user">${gifter}</span> gifted a sub to ` +
          `<span class="user">${name}</span>`
        );
      } else {
        if (!settings.showSubs) return;
        const months = item.months || item.streak_months;
        // Reads "SUB <name> <message> (<n> month|months)". No "subscribed" wording – the
        // SUB tag already says it – and the sub's own message (resubs can carry
        // one) is shown when there is one. Same handling for Kick and Twitch.
        // Twitch resub messages can contain emotes; Streamlabs passes them in
        // `emotes` in the same "id:start-end" format as Twitch chat, so they go
        // through the same renderer (the message isn't trimmed first – that
        // would shift the positions). Everything else is plain escaped text.
        const subMessage = item.message != null ? String(item.message) : '';
        const subHtml = !subMessage.trim() ? ''
          : plat === 'plat-twitch' && typeof item.emotes === 'string'
            ? renderTwitchChatContent(subMessage, item.emotes)
            : escapeHtml(subMessage.trim());
        addLine(withPlat('sub'),
          `<span class="tag">SUB</span><span class="user">${name}</span>` +
          (subHtml ? ` <span class="msg">${subHtml}</span>` : '') +
          (months ? ` <span class="amount">(${escapeHtml(String(months))} ${Number(months) === 1 ? 'month' : 'months'})</span>` : '')
        );
      }
      return;
    }

    // Twitch bits: { name, amount: "100", message, ... } for: twitch_account
    case 'bits':
    case 'cheer': {
      if (!settings.showBits) return;
      const bits = Number(item.amount);
      const amount = escapeHtml(Number.isFinite(bits) ? bits.toLocaleString() : String(item.amount || ''));
      const msg = item.message ? `: <span class="msg">${escapeHtml(item.message)}</span>` : '';
      // Bits only exist on Twitch, so they're Twitch-colored even if the
      // payload doesn't say which platform it came from.
      addLine(`bits ${plat || 'plat-twitch'}`,
        `<span class="tag">BITS</span><span class="user">${name}</span> ` +
        `cheered <span class="amount">${amount}</span>${msg}`
      );
      return;
    }

    // Raids: Twitch is { name, raiders }. Kick's shape via Streamlabs isn't
    // documented, so a few likely field names are tried as fallbacks.
    case 'raid': {
      const count = item.raiders ?? item.viewers ?? item.count ?? item.amount ?? item.number_viewers;
      showRaid(plat, item.display_name || item.name || item.from || item.raider, count);
      return;
    }

    case 'donation': {
      if (!settings.showTips) return;
      const amount = escapeHtml(formatAmount(item));
      const msg = item.message ? `: <span class="msg">${escapeHtml(item.message)}</span>` : '';

      // Kept as a fallback alongside the confirmed "kicks" case below, in
      // case a Kicks tip ever arrives this way instead (tagged for:
      // "kick_account" like Streamlabs' other platform-native events).
      const src = (source || '').toLowerCase();
      const isKicks = src.includes('kick');
      const isPaypal = !source || src === 'streamlabs';
      const label = isKicks ? 'KICKS' : isPaypal ? 'PAYPAL' : 'TIP';
      const variant = isKicks ? 'tip-kicks' : isPaypal ? 'tip-paypal' : '';
      const level = isKicks && item.levelName ? ` <span class="level">(${escapeHtml(item.levelName)})</span>` : '';

      addLine(`tip ${variant}`.trim(),
        `<span class="tag">${label}</span><span class="user">${name}</span> ` +
        `sent <span class="amount">${amount}</span>${level}${msg}`
      );
      return;
    }

    // Confirmed from a live payload: a Kicks tip arrives wrapped in a
    // generic "alertPlaying" envelope (unwrapped above, in
    // handleStreamlabsEvent) with its own type – "kicks" – plus
    // kickTier/kickType/levelName fields not present on other tip types.
    case 'kicks':
    case 'kick_tip':
    case 'kickTip': {
      if (!settings.showTips) return;
      const amount = escapeHtml(formatAmount(item));
      const msg = item.message ? `: <span class="msg">${escapeHtml(item.message)}</span>` : '';
      const level = item.levelName ? ` <span class="level">(${escapeHtml(item.levelName)})</span>` : '';
      addLine('tip tip-kicks',
        `<span class="tag">KICKS</span><span class="user">${name}</span> ` +
        `sent <span class="amount">${amount}</span>${level}${msg}`
      );
      return;
    }

    default:
      // Unrecognized alert type – left out of the feed but visible in devtools
      // console (see the unconditional console.debug above) for calibration.
      console.warn('[streamlabs] unhandled alert type – open devtools to inspect the payload:', type, 'for:', source, item);
      return;
  }
}

// Streamlabs appears to redeliver the same Kick-platform alert more than
// once in some cases (its payloads carry "repeat"/"historical" flags, which
// suggests replays rather than a fresh event each time). Every alert item
// has a stable `_id` (falling back to `hash`), so a short-lived seen-set
// filters out exact repeats without touching genuinely new alerts, which
// always get a new id.
const seenAlertIds = new Set();
const MAX_SEEN_ALERT_IDS = 300;

function isDuplicateAlert(item) {
  const id = item && (item._id || item.hash);
  if (!id) return false;
  if (seenAlertIds.has(id)) return true;
  seenAlertIds.add(id);
  if (seenAlertIds.size > MAX_SEEN_ALERT_IDS) {
    seenAlertIds.delete(seenAlertIds.values().next().value);
  }
  return false;
}

function handleStreamlabsEvent(eventData) {
  if (!eventData || !eventData.type) return;
  const items = Array.isArray(eventData.message) ? eventData.message : [eventData.message];
  items.filter(Boolean).forEach((item) => {
    if (isDuplicateAlert(item)) {
      console.debug('[streamlabs] skipped duplicate alert:', item._id || item.hash);
      return;
    }
    // Confirmed live: Kick-specific alerts (Kicks tips, and apparently Kick's
    // multi-sub gift bombs too) don't come through as a normal "donation" /
    // "subscription" top-level type – they arrive wrapped in a generic
    // "alertPlaying" envelope, with the real type/platform nested inside the
    // item itself (item.type: "kicks", item.platform: "kick_account").
    // Unwrap that here so those route the same way ordinary alerts do.
    const effectiveType = eventData.type === 'alertPlaying' ? (item.type || eventData.type) : eventData.type;
    const effectiveSource = eventData.for || item.platform;
    handleStreamlabsItem(effectiveType, item, effectiveSource);
  });
}

// ---------------------------------------------------------------------------
// NanoDrops stats – fetched and computed in the main process; renderer just
// formats and displays whatever arrives.
// ---------------------------------------------------------------------------

function fmtXno(n) {
  const decimals = Math.max(0, Math.min(8, settings.xnoDecimals != null ? settings.xnoDecimals : 2));
  return n == null ? '–' : `<span class="accent">Ӿ</span>${Number(n).toFixed(decimals)}`;
}

// Same as fmtXno, but always rounds up to the display precision rather than
// to the nearest value. Used only for the JUICED "anonymous deposit" amount:
// that figure is a balance-delta heuristic which can undershoot the real
// deposit slightly when viewer drops land in the same poll window (see the
// note in main.js's computeAnonymousDeposit) but never overshoots it, so
// rounding up there consistently favors the true amount instead of
// occasionally clipping down to the decimal place below it.
//
// Only the single digit immediately after the display precision decides
// whether to round up (e.g. at 2 decimal places, only the 3rd decimal
// matters) — deeper digits are floating-point noise, not real precision
// (the balance math can produce something like 0.5500000000000003 for what
// is really just 0.55), and letting those decide the rounding would bump an
// already-exact amount up to the next display step for no reason.
function fmtXnoRoundedUp(n) {
  const decimals = Math.max(0, Math.min(8, settings.xnoDecimals != null ? settings.xnoDecimals : 2));
  if (n == null) return '–';
  // toFixed's own rounding collapses any noise past this one extra digit,
  // leaving just the digit that actually decides whether to round up.
  const extended = Number(n).toFixed(decimals + 1);
  const truncated = Number(extended.slice(0, -1) || '0');
  const lastDigit = extended[extended.length - 1];
  const roundedUp = lastDigit === '0' ? truncated : Number((truncated + 1 / 10 ** decimals).toFixed(decimals));
  return `<span class="accent">Ӿ</span>${roundedUp.toFixed(decimals)}`;
}

function fmtUsd(n) {
  return n == null ? '–' : Number(n).toFixed(2);
}

function setNanodropsStat(id, hasValue, text) {
  const chip = document.getElementById(id);
  const valueEl = document.getElementById(`${id}-value`);
  if (!chip || !valueEl) return;
  if (!settings.showNanodrops || !hasValue) {
    chip.classList.add('hidden');
    return;
  }
  valueEl.innerHTML = text;
  chip.classList.remove('hidden');
}

let seenNanoMessageIds = new Set();

// Faucets whose existing history has already been absorbed as a baseline.
// The first payload that carries fresh data for a faucet – even if its history
// is empty – is treated as "what was already there", remembered but not
// announced; only what arrives after that shows up as alerts. It's tracked per
// faucet (not once for the whole overlay) so that adding a second faucet,
// changing a faucet ID, or switching nanodrops off and on again doesn't replay
// that faucet's recent history as a burst of alerts. (It also used to be
// decided by "was the first list non-empty?", so a faucet with no history at
// startup swallowed its first real message or drop as if it were history.)
let baselinedFaucets = new Set();

// ---------------------------------------------------------------------------
// Drop ticker – a static (non-scrolling) line under the stats line showing
// the faucet's raw drop log (viewer, amount, streamer – no message text).
// It sits empty/hidden until the first new drop lands, then always shows the
// most recent drops, oldest-of-the-visible-set on the left, dropping older
// ones off as needed to keep the line from overflowing the window.
// ---------------------------------------------------------------------------

let seenDropIds = new Set();
let recentDrops = []; // newest first; trimmed to whatever fits on screen
const MAX_RECENT_DROPS = 20; // upper bound before width-based trimming kicks in

function formatDropItemHtml(d) {
  const decimals = Math.max(0, Math.min(8, settings.dropDecimals != null ? settings.dropDecimals : 4));
  const amt = d.amountXno != null ? Number(d.amountXno).toFixed(decimals) : '–';
  return `<span class="drop-item"><span class="user">${escapeHtml(d.viewerName || 'Someone')}</span> ` +
    `<span class="amount">+Ӿ${amt}</span></span>`;
}

function renderDropLine() {
  const container = document.getElementById('drop-ticker');
  const track = document.getElementById('drop-ticker-track');
  if (!container || !track) return;

  if (recentDrops.length === 0 || !settings.showNanodrops) {
    container.classList.add('hidden');
    track.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');

  const build = () => recentDrops
    .map((d, i) => (i === 0 ? '' : '<span class="sep">&middot;</span>') + formatDropItemHtml(d))
    .join('');
  track.innerHTML = build();

  // Drop the oldest entries (now at the end of the array) until the line
  // fits without overflowing – it's meant to be a static, fully-visible
  // line, not something that needs to scroll or wrap.
  while (recentDrops.length > 1 && track.scrollWidth > container.clientWidth) {
    recentDrops.pop();
    track.innerHTML = build();
  }
}

function handleNanodropsDrops(drops, baselineFaucets) {
  if (!Array.isArray(drops) || drops.length === 0) return;

  // Don't flood the line with a faucet's existing drop history the first time
  // it's seen – only show ones that land afterwards.
  drops.forEach((d) => {
    if (baselineFaucets.has(d.faucetId)) seenDropIds.add(d.id);
  });

  if (!settings.showNanodrops) {
    drops.forEach((d) => seenDropIds.add(d.id));
    return;
  }

  // Newest-first, regardless of the order the API returns them in, so a new
  // drop lands at the left edge and older ones sit further to the right.
  const fresh = drops
    .filter((d) => !seenDropIds.has(d.id))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  if (fresh.length === 0) return;

  fresh.forEach((d) => seenDropIds.add(d.id));
  recentDrops = [...fresh, ...recentDrops];
  if (recentDrops.length > MAX_RECENT_DROPS) {
    recentDrops = recentDrops.slice(0, MAX_RECENT_DROPS);
  }

  renderDropLine();

  if (seenDropIds.size > 500) {
    seenDropIds = new Set(Array.from(seenDropIds).slice(-250));
  }
}

// Maps a nanodrops faucet id back to which stream it belongs to. With both
// faucet IDs set, the first box (Kick Faucet ID) is Kick's and the second
// (Twitch Faucet ID) is Twitch's - to swap them, swap the two entries below.
// With only one faucet set there's nothing to tell apart, so it takes the
// colour of whichever platform is live (Kick if both are, Kick if neither).
// Returns 'kick', 'twitch', or null if the id matches neither box (e.g. it
// was just changed in settings and this message predates the change).
const FAUCET_SLOT_PLATFORMS = ['kick', 'twitch']; // [first box, second box]
function faucetPlatformFor(faucetId) {
  if (!faucetId) return null;
  const first = settings.nanodropsFaucetId;
  const second = settings.nanodropsFaucetId2;
  if (first && second) {
    if (faucetId === first) return FAUCET_SLOT_PLATFORMS[0];
    if (faucetId === second) return FAUCET_SLOT_PLATFORMS[1];
    return null;
  }
  if (faucetId !== first && faucetId !== second) return null;
  return liveState.kick.live || !liveState.twitch.live ? 'kick' : 'twitch';
}

function handleNanodropsMessages(messages, baselineFaucets) {
  if (!Array.isArray(messages) || messages.length === 0) return;

  messages.forEach((m) => {
    if (seenNanoMessageIds.has(m.id)) return;
    seenNanoMessageIds.add(m.id);
    // A faucet's existing message history isn't replayed the first time it's
    // seen – only messages that arrive afterwards show, like live chat.
    if (baselineFaucets.has(m.faucetId)) return;
    if (!settings.showNanodrops) return;

    const amountXno = m.amount && m.amount.xno != null ? Number(m.amount.xno) : null;
    // "tip" = a direct viewer-to-viewer/streamer tip. "faucet-deposit" is a
    // synthetic entry (added in main.js) for a faucet balance increase that
    // didn't come with a name/message attached – shown as its own JUICED
    // line, just without a user. Anything else is a normal named
    // contribution into the faucet pool itself.
    const isDirectTip = m.kind === 'tip';
    const isAnonymousDeposit = m.kind === 'faucet-deposit';
    const tag = isDirectTip ? 'NANO' : 'JUICED';
    // Which stream's faucet this message came from, so JUICED lines can name
    // it ("Kick faucet" / "Twitch faucet") in that platform's brand color.
    // Falls back to a plain, uncolored "faucet" if the id doesn't match
    // either configured faucet (e.g. it was just changed in settings).
    const faucetPlatform = faucetPlatformFor(m.faucetId);
    const faucetLabel = faucetPlatform
      ? `<span class="faucet-platform-word faucet-platform-${faucetPlatform}">${faucetPlatform === 'kick' ? 'Kick' : 'Twitch'}</span> faucet`
      : 'faucet';

    let body;
    if (isAnonymousDeposit) {
      // Logged unconditionally, same reasoning as the Streamlabs debug log:
      // this is a balance-delta heuristic (nets newly-seen named messages
      // out of the raw balance increase), so if the reported amount ever
      // looks off, the underlying numbers are here in DevTools to check.
      console.debug('[nanodrops] anonymous deposit', amountXno, m.debug || null);
      body = `<span class="tag">${tag}</span>${faucetLabel} juiced ` +
        `<span class="amount">${fmtXnoRoundedUp(amountXno)}</span>`;
    } else {
      const verb = isDirectTip ? 'tipped' : `juiced the ${faucetLabel} with`;
      body = `<span class="tag">${tag}</span><span class="user">${escapeHtml(m.name || 'Someone')}</span> ` +
        `${verb} <span class="amount">${fmtXno(amountXno)}</span>` +
        (m.text ? `: <span class="msg">${escapeHtml(m.text)}</span>` : '');
    }
    addLine(isDirectTip ? 'nanotip' : 'nanotip nanotip-faucet', body);
  });

  if (seenNanoMessageIds.size > 500) {
    seenNanoMessageIds = new Set(Array.from(seenNanoMessageIds).slice(-250));
  }
}

function handleNanodropsData(data) {
  if (!data) return;
  setNanodropsStat('stat-nd-watchers', data.streamWatchers != null, String(data.streamWatchers));
  setNanodropsStat('stat-nd-rate', data.hourlyRateUsd != null, fmtUsd(data.hourlyRateUsd));
  handleNanodropsFaucets(data.faucets);
  handleNanodropsPool(data.networkActiveNanoXno, data.networkActiveUsers);

  // Any faucet appearing in `freshFaucetIds` for the first time has just had
  // its baseline delivered in this very payload – see baselinedFaucets.
  const newlyBaselined = new Set((data.freshFaucetIds || []).filter((id) => !baselinedFaucets.has(id)));
  handleNanodropsMessages(data.messages, newlyBaselined);
  handleNanodropsDrops(data.drops, newlyBaselined);
  newlyBaselined.forEach((id) => baselinedFaucets.add(id));
}

// One balance chip per platform (Kick green / Twitch purple), so both faucets
// show when both are set up. As before, a faucet whose stream is offline
// leaves its balance out; a faucet with no reported status counts as online.
// Should two faucets somehow resolve to the same platform, the bigger balance wins.
function handleNanodropsFaucets(faucets) {
  const best = { kick: null, twitch: null };
  (Array.isArray(faucets) ? faucets : []).forEach((f) => {
    if (!f || f.online === false || f.balanceXno == null) return;
    const platform = faucetPlatformFor(f.id);
    if (!platform) return;
    const balance = Number(f.balanceXno);
    if (best[platform] == null || balance > best[platform]) best[platform] = balance;
  });
  ['kick', 'twitch'].forEach((platform) => {
    setNanodropsStat(`stat-nd-faucet-${platform}`, best[platform] != null, fmtXno(best[platform]));
  });
}

function handleNanodropsPool(balanceXno, viewers) {
  const chip = document.getElementById('stat-nd-pool');
  const balanceEl = document.getElementById('stat-nd-pool-balance');
  const viewersEl = document.getElementById('stat-nd-pool-viewers');
  if (!chip) return;
  const hasValue = balanceXno != null || viewers != null;
  if (!settings.showNanodrops || !hasValue) {
    chip.classList.add('hidden');
    return;
  }
  balanceEl.innerHTML = fmtXno(balanceXno);
  viewersEl.textContent = viewers != null ? String(viewers) : '–';
  chip.classList.remove('hidden');
}

function hideNanodropsChips() {
  ['stat-nd-watchers', 'stat-nd-rate', 'stat-nd-faucet-kick', 'stat-nd-faucet-twitch', 'stat-nd-pool']
    .forEach((id) => document.getElementById(id)?.classList.add('hidden'));
}

let nanodropsDown = false;

// `ok: false` now means "nothing usable at all" (no faucet configured, or every
// source has been failing for a while) – a single failed poll no longer gets
// here, and a partial failure comes through as `ok: true, warn: true` with the
// stats still showing. When it *is* down, the drop ticker is only hidden, not
// emptied: its drops are already marked as seen, so emptying it meant it could
// never refill once the connection came back.
function handleNanodropsStatus(status) {
  const el = document.getElementById('nanodrops-status');
  if (!el) return;
  el.textContent = status.message;
  el.className = `status ${status.ok && !status.warn ? 'ok' : 'err'}`;
  if (!status.ok) {
    nanodropsDown = true;
    hideNanodropsChips();
    document.getElementById('drop-ticker')?.classList.add('hidden');
  } else if (nanodropsDown) {
    nanodropsDown = false;
    renderDropLine(); // bring the ticker back with whatever it had
  }
}

// ---------------------------------------------------------------------------
// OBS WebSocket (obs-websocket v5, built into OBS 28+) – mic/desktop mute
// and webcam visibility status. Connects directly from the renderer, same
// as the Kick chat socket.
// Docs: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
// ---------------------------------------------------------------------------

let obsSocket = null;
let obsReconnectTimer = null;
const OBS_CLOSE_AUTH_FAILED = 4009; // obs-websocket's "AuthenticationFailed" close code
const OBS_AUTH_RETRY_MS = 30000;
let obsRequestSeq = 0;
let obsPendingMuteRequests = new Map(); // requestId -> inputName
let obsWebcamSceneName = null; // scene the tracked webcam scene-item belongs to
let obsWebcamItemId = null; // scene-item id of the webcam source within that scene

function setObsStatus(text, cls) {
  const el = document.getElementById('obs-status');
  if (el) {
    el.textContent = text;
    el.className = `status ${cls || ''}`.trim();
  }
}

// Drives both the stats-bar chip and its twin in the top drag bar from one
// call, since mic/desktop/camera status is mirrored in both places.
function setObsStatusChips(ids, isLive) {
  ids.forEach((id) => {
    const chip = document.getElementById(id);
    const svg = chip ? chip.querySelector('svg') : null;
    if (!chip || !svg) return;
    svg.classList.toggle('icon-status-muted', !isLive);
    svg.classList.toggle('icon-status-live', !!isLive);
    chip.classList.remove('hidden');
  });
}

function hideObsChips(ids) {
  ids.forEach((id) => document.getElementById(id)?.classList.add('hidden'));
}

// ---------------------------------------------------------------------------
// Drag strip mute indicator – paints the top bar (clock, settings cog, lock,
// close, etc.) red when the configured mic is muted in OBS, orange when only
// desktop audio is muted (mic takes precedence when both are). This replaces
// an earlier per-level volume meter bar: that required near-continuous DOM
// writes for as long as there was mic activity (even throttled to a fixed
// interval, independent of the level itself changing) and caused in-game
// stutter on some setups, especially high-refresh-rate monitors. A mute/live
// state only changes on demand, so this needs no ongoing work at all.
// ---------------------------------------------------------------------------

let micMuted = false;
let desktopMuted = false;

function updateDragStripMuteColor() {
  if (!dragStripEl) return;
  dragStripEl.classList.toggle('muted-mic', micMuted);
  dragStripEl.classList.toggle('muted-desktop', !micMuted && desktopMuted);
}

function applyObsMuteState(inputName, muted) {
  if (!inputName) return;
  if (inputName === settings.obsMicSource) {
    setObsStatusChips(['drag-obs-mic'], !muted);
    micMuted = muted;
    updateDragStripMuteColor();
  }
  if (inputName === settings.obsDesktopSource) {
    setObsStatusChips(['drag-obs-desktop'], !muted);
    desktopMuted = muted;
    updateDragStripMuteColor();
  }
}

function applyObsCameraState(visible) {
  setObsStatusChips(['drag-obs-camera'], !!visible);
}

// Webcams don't have a mute toggle – what we can track is whether their
// scene-item is enabled (shown) in the current program scene. This means
// resolving a scene name -> scene-item id first, then watching that item.
function requestCurrentScene() {
  obsSend({ op: 6, d: { requestType: 'GetCurrentProgramScene', requestId: 'current-scene' } });
}

function requestWebcamItemId(sceneName) {
  obsWebcamSceneName = sceneName;
  obsWebcamItemId = null;
  obsSend({
    op: 6,
    d: {
      requestType: 'GetSceneItemId',
      requestId: 'webcam-item-id',
      requestData: { sceneName, sourceName: settings.obsWebcamSource }
    }
  });
}

function requestWebcamItemEnabled() {
  if (!obsWebcamSceneName || obsWebcamItemId == null) return;
  obsSend({
    op: 6,
    d: {
      requestType: 'GetSceneItemEnabled',
      requestId: 'webcam-item-enabled',
      requestData: { sceneName: obsWebcamSceneName, sceneItemId: obsWebcamItemId }
    }
  });
}

async function sha256Base64(str) {
  const bytes = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

// obs-websocket v5 auth: base64(sha256(base64(sha256(password + salt)) + challenge))
async function computeObsAuth(password, salt, challenge) {
  const secret = await sha256Base64(password + salt);
  return sha256Base64(secret + challenge);
}

function obsSend(payload) {
  if (obsSocket && obsSocket.readyState === WebSocket.OPEN) {
    obsSocket.send(JSON.stringify(payload));
  }
}

function requestInputMute(inputName) {
  obsRequestSeq += 1;
  const requestId = `mute-${obsRequestSeq}`;
  obsPendingMuteRequests.set(requestId, inputName);
  obsSend({ op: 6, d: { requestType: 'GetInputMute', requestId, requestData: { inputName } } });
}

function connectObs() {
  if (obsSocket) {
    // Detach first: a closing socket's async "close" event would otherwise
    // schedule a reconnect that kills the replacement connection, which
    // schedules another, and so on forever (see teardownTwitchSocket).
    const old = obsSocket;
    obsSocket = null;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try { old.close(); } catch (_) { /* noop */ }
  }
  clearTimeout(obsReconnectTimer);
  obsPendingMuteRequests.clear();
  obsWebcamSceneName = null;
  obsWebcamItemId = null;

  hideObsChips(['drag-obs-mic', 'drag-obs-desktop', 'drag-obs-camera']);
  micMuted = false;
  desktopMuted = false;
  updateDragStripMuteColor();

  if (!settings.obsEnabled) {
    setObsStatus('Not enabled');
    markLoadDone('obs');
    return;
  }

  const host = (settings.obsWsHost || '127.0.0.1').trim();
  const port = String(settings.obsWsPort || '4455').trim();
  setObsStatus('Connecting…');
  obsSocket = new WebSocket(`ws://${host}:${port}`);

  obsSocket.onmessage = async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.data); } catch (_) { return; }

    // Hello – authenticate (if OBS has auth enabled) and Identify.
    if (msg.op === 0) {
      const auth = msg.d && msg.d.authentication;
      const authentication = auth
        ? await computeObsAuth(settings.obsWsPassword || '', auth.salt, auth.challenge)
        : undefined;
      obsSend({
        op: 1,
        // General(1) + Scenes(4) + Inputs(8) + SceneItems(128): mute state,
        // scene, and scene-item visibility. No high-volume categories (e.g.
        // InputVolumeMeters) – nothing here needs continuous level data any
        // more, so there's no reason to have OBS stream it at all.
        d: { rpcVersion: 1, authentication, eventSubscriptions: 141 }
      });
      return;
    }

    // Identified – connected and authenticated; fetch current mute/visibility states.
    if (msg.op === 2) {
      setObsStatus('Connected', 'ok');
      if (settings.obsMicSource) requestInputMute(settings.obsMicSource);
      if (settings.obsDesktopSource) requestInputMute(settings.obsDesktopSource);
      if (settings.obsWebcamSource) requestCurrentScene();
      return;
    }

    // RequestResponse – reply to one of the requests sent above.
    if (msg.op === 7) {
      const req = msg.d || {};

      if (req.requestId === 'current-scene') {
        const sceneName = req.requestStatus && req.requestStatus.result
          ? req.responseData && req.responseData.currentProgramSceneName
          : null;
        if (sceneName) requestWebcamItemId(sceneName);
        else markLoadDone('obs');
        return;
      }

      if (req.requestId === 'webcam-item-id') {
        if (req.requestStatus && req.requestStatus.result) {
          obsWebcamItemId = req.responseData && req.responseData.sceneItemId;
          requestWebcamItemEnabled();
        } else {
          // Webcam source isn't in this scene (e.g. a BRB scene) – just hide
          // the chip rather than treating it as a connection error.
          hideObsChips(['drag-obs-camera']);
          markLoadDone('obs');
        }
        return;
      }

      if (req.requestId === 'webcam-item-enabled') {
        if (req.requestStatus && req.requestStatus.result) {
          applyObsCameraState(req.responseData && req.responseData.sceneItemEnabled);
        }
        markLoadDone('obs');
        return;
      }

      const inputName = obsPendingMuteRequests.get(req.requestId);
      obsPendingMuteRequests.delete(req.requestId);
      if (inputName && req.requestStatus && req.requestStatus.result) {
        applyObsMuteState(inputName, req.responseData && req.responseData.inputMuted);
      }
      markLoadDone('obs');
      return;
    }

    // Event – live mute/scene/visibility changes while connected.
    if (msg.op === 5 && msg.d) {
      const { eventType } = msg.d;
      const eventData = msg.d.eventData || {};

      if (eventType === 'InputMuteStateChanged') {
        applyObsMuteState(eventData.inputName, eventData.inputMuted);
      }

      // Scene switched – the webcam source may or may not exist in the new
      // scene, so re-resolve its scene-item id there.
      if (eventType === 'CurrentProgramSceneChanged' && settings.obsWebcamSource) {
        requestWebcamItemId(eventData.sceneName);
      }

      if (
        eventType === 'SceneItemEnableStateChanged' &&
        eventData.sceneName === obsWebcamSceneName &&
        eventData.sceneItemId === obsWebcamItemId
      ) {
        applyObsCameraState(eventData.sceneItemEnabled);
      }
    }
  };

  obsSocket.onclose = (ev) => {
    markLoadDone('obs'); // don't hang the startup indicator if OBS isn't running
    if (!settings.obsEnabled) return;
    // OBS rejects a wrong (or missing) password by closing the connection with
    // this specific code. Say so – it used to look identical to "OBS isn't
    // running" and just retried every 4 seconds forever – and back off, since
    // retrying with the same password can't succeed until it's fixed.
    if (ev && ev.code === OBS_CLOSE_AUTH_FAILED) {
      setObsStatus('Wrong OBS WebSocket password – check Settings → OBS', 'err');
      obsReconnectTimer = setTimeout(connectObs, OBS_AUTH_RETRY_MS);
      return;
    }
    setObsStatus('Disconnected, retrying…', 'err');
    obsReconnectTimer = setTimeout(connectObs, 4000);
  };

  obsSocket.onerror = () => {
    // onclose fires right after; reconnect is handled there.
  };
}

// ---------------------------------------------------------------------------
// Settings panel wiring
// ---------------------------------------------------------------------------

function openSettings() { settingsPanel.classList.remove('hidden'); }
function closeSettings() { settingsPanel.classList.add('hidden'); }

function updateLockIcon(locked) {
  const btn = document.getElementById('btn-lock');
  // Closed padlock (🔒) while locked/click-through, open padlock (🔓) while
  // unlocked. Unlocked means the overlay is still catching clicks, which is
  // easy to forget mid-stream, so it gets a bright red flag at full opacity;
  // locked (safe, click-through) fades back to low opacity out of the way.
  btn.innerHTML = locked ? '&#128274;' : '&#128275;';
  btn.style.color = locked ? '' : '#ff5656';
  btn.style.opacity = locked ? '0.35' : '1';
}

document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);

document.getElementById('btn-quit').addEventListener('click', () => overlay.quit());

document.getElementById('btn-lock').addEventListener('click', () => overlay.toggleClickThrough());
overlay.onClickThroughChanged((locked) => {
  updateLockIcon(locked);
});

// ---------------------------------------------------------------------------
// Lock shortcut rebinding
// ---------------------------------------------------------------------------

const SHORTCUT_KEY_NAMES = {
  ' ': 'Space',
  'Escape': 'Esc',
  'Enter': 'Return',
  'ArrowUp': 'Up',
  'ArrowDown': 'Down',
  'ArrowLeft': 'Left',
  'ArrowRight': 'Right',
  'Delete': 'Delete',
  'Backspace': 'Backspace',
  'Tab': 'Tab',
  'Insert': 'Insert',
  'Home': 'Home',
  'End': 'End',
  'PageUp': 'PageUp',
  'PageDown': 'PageDown',
  // KeyboardEvent.key names that Electron's accelerator syntax spells differently:
  'CapsLock': 'Capslock',
  'NumLock': 'Numlock',
  'ScrollLock': 'Scrolllock',
  'PrintScreen': 'PrintScreen',
  'AudioVolumeUp': 'VolumeUp',
  'AudioVolumeDown': 'VolumeDown',
  'AudioVolumeMute': 'VolumeMute',
  'MediaTrackNext': 'MediaNextTrack',
  'MediaTrackPrevious': 'MediaPreviousTrack',
  'MediaPlayPause': 'MediaPlayPause',
  'MediaStop': 'MediaStop'
};

// Turns a keydown event into an Electron accelerator string, e.g. "Control+Shift+L"
// or a bare key like "F20". Returns { pending: true } while only modifier
// keys are held, { accelerator } once it's a valid combo, or { error } for a
// key that has no accelerator name at all (dead keys, non-ASCII characters…).
function captureKeyToAccelerator(e) {
  const key = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return { pending: true };

  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  let mainKey;
  if (SHORTCUT_KEY_NAMES[key]) mainKey = SHORTCUT_KEY_NAMES[key];
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) mainKey = key;
  else if (key === '+') mainKey = 'Plus'; // a literal "+" would be read as the separator
  else if (/^[\x21-\x7e]$/.test(key)) mainKey = key.toUpperCase(); // printable ASCII
  else return { error: `That key ("${key}") can't be used as a shortcut.` };

  return { accelerator: [...mods, mainKey].join('+') };
}

const rebindBtn = document.getElementById('btn-rebind-lock');
let capturingLockShortcut = false;

function setLockRebindStatus(text, cls) {
  const el = document.getElementById('lock-shortcut-status');
  if (el) {
    el.textContent = text;
    el.className = `status ${cls || ''}`.trim();
  }
}

function startCapture() {
  capturingLockShortcut = true;
  rebindBtn.textContent = 'Press a key combination…';
  rebindBtn.classList.add('capturing');
  setLockRebindStatus('');
}

function stopCapture(displayText) {
  capturingLockShortcut = false;
  rebindBtn.classList.remove('capturing');
  rebindBtn.textContent = displayText;
}

rebindBtn.addEventListener('click', () => {
  if (!capturingLockShortcut) startCapture();
});

rebindBtn.addEventListener('keydown', async (e) => {
  if (!capturingLockShortcut) return;
  e.preventDefault();
  e.stopPropagation();

  const fallback = settings.lockShortcut || 'Control+Shift+L';

  if (e.key === 'Escape') {
    stopCapture(fallback);
    return;
  }

  const result = captureKeyToAccelerator(e);
  if (result.pending) return;
  if (result.error) {
    setLockRebindStatus(result.error, 'err');
    return;
  }

  rebindBtn.textContent = result.accelerator;
  // Whatever goes wrong, capture mode must end – an unhandled failure here
  // used to leave the button stuck on "Press a key combination…" until Esc.
  let res;
  try {
    res = await overlay.setLockShortcut(result.accelerator);
  } catch (err) {
    res = { ok: false, invalid: true };
  }
  if (res.ok) {
    settings.lockShortcut = res.accelerator;
    stopCapture(res.accelerator);
    setLockRebindStatus('Saved.', 'ok');
  } else {
    stopCapture(res.accelerator || fallback);
    setLockRebindStatus(
      res.invalid
        ? `${result.accelerator} isn't a key combination that can be used as a shortcut.`
        : `Could not bind ${result.accelerator} – already in use by something else.`,
      'err'
    );
  }
});

rebindBtn.addEventListener('blur', () => {
  if (capturingLockShortcut) stopCapture(settings.lockShortcut || 'Control+Shift+L');
});

// ---------------------------------------------------------------------------
// Clear-chat shortcut rebinding (same capture approach as the lock shortcut
// above, including plain single keys like the default, F21 – not just
// modifier combinations).
// ---------------------------------------------------------------------------

const clearChatRebindBtn = document.getElementById('btn-rebind-clear-chat');
let capturingClearChatShortcut = false;

function setClearChatRebindStatus(text, cls) {
  const el = document.getElementById('clear-chat-shortcut-status');
  if (el) {
    el.textContent = text;
    el.className = `status ${cls || ''}`.trim();
  }
}

function startClearChatCapture() {
  capturingClearChatShortcut = true;
  clearChatRebindBtn.textContent = 'Press a key…';
  clearChatRebindBtn.classList.add('capturing');
  setClearChatRebindStatus('');
}

function stopClearChatCapture(displayText) {
  capturingClearChatShortcut = false;
  clearChatRebindBtn.classList.remove('capturing');
  clearChatRebindBtn.textContent = displayText;
}

clearChatRebindBtn.addEventListener('click', () => {
  if (!capturingClearChatShortcut) startClearChatCapture();
});

clearChatRebindBtn.addEventListener('keydown', async (e) => {
  if (!capturingClearChatShortcut) return;
  e.preventDefault();
  e.stopPropagation();

  const fallback = settings.clearChatShortcut || 'F21';

  if (e.key === 'Escape') {
    stopClearChatCapture(fallback);
    return;
  }

  const result = captureKeyToAccelerator(e);
  if (result.pending) return;
  if (result.error) {
    setClearChatRebindStatus(result.error, 'err');
    return;
  }

  clearChatRebindBtn.textContent = result.accelerator;
  let res;
  try {
    res = await overlay.setClearChatShortcut(result.accelerator);
  } catch (err) {
    res = { ok: false, invalid: true };
  }
  if (res.ok) {
    settings.clearChatShortcut = res.accelerator;
    stopClearChatCapture(res.accelerator);
    setClearChatRebindStatus('Saved.', 'ok');
  } else {
    stopClearChatCapture(res.accelerator || fallback);
    setClearChatRebindStatus(
      res.invalid
        ? `${result.accelerator} isn't a key combination that can be used as a shortcut.`
        : `Could not bind ${result.accelerator} – already in use by something else.`,
      'err'
    );
  }
});

clearChatRebindBtn.addEventListener('blur', () => {
  if (capturingClearChatShortcut) stopClearChatCapture(settings.clearChatShortcut || 'F21');
});

// Shows a faint outline around the window's true bounds while it has focus,
// since it's otherwise fully transparent and easy to lose track of.
overlay.onWindowFocusChanged((focused) => {
  document.body.classList.toggle('window-focused', focused);
});

overlay.onOpenSettings(() => openSettings());

document.getElementById('btn-detect-chatroom').addEventListener('click', async () => {
  const slug = document.getElementById('in-kick-channel').value;
  if (!slug) return;
  const input = document.getElementById('in-kick-chatroom');
  input.value = 'looking up…';
  try {
    const id = await resolveChatroomId(slug);
    input.value = id;
  } catch (err) {
    input.value = '';
    alert(`Couldn't auto-detect (${err.message}). Open kick.com/api/v2/channels/${slug} in a browser and copy the "chatroom": { "id": ... } value in manually.`);
  }
});

// Live preview for appearance sliders.
document.getElementById('in-font-size').addEventListener('input', (e) => {
  document.documentElement.style.setProperty('--font-size', `${e.target.value}px`);
});
document.getElementById('in-bg-opacity').addEventListener('input', (e) => {
  document.documentElement.style.setProperty('--bg-opacity', e.target.value);
});
document.getElementById('in-drag-bar-opacity').addEventListener('input', (e) => {
  document.documentElement.style.setProperty('--drag-bar-opacity', e.target.value);
});

// Accepts what people actually paste into the channel boxes – "kick.com/name",
// "https://www.twitch.tv/name/", "@name", "#name" – and returns just the name.
function normalizeChannelName(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  s = s.replace(/^(?:[a-z0-9-]+\.)*(?:kick\.com|twitch\.tv)\//i, '');
  s = s.replace(/^[@#]+/, '');
  return s.split(/[/?#\s]/)[0];
}

document.getElementById('btn-save').addEventListener('click', async () => {
  const prevChannel = settings.kickChannel;
  const prevChatroom = settings.kickChatroomId;
  const prevShowTwitch = !!settings.showTwitchChat;
  const OBS_KEYS = ['obsEnabled', 'obsWsHost', 'obsWsPort', 'obsWsPassword', 'obsMicSource', 'obsDesktopSource', 'obsWebcamSource'];
  const prevObs = OBS_KEYS.map((k) => settings[k]);
  const prevTwitchChannel = settings.twitchChannel;

  const patch = {
    kickChannel: normalizeChannelName(document.getElementById('in-kick-channel').value),
    kickChatroomId: document.getElementById('in-kick-chatroom').value.trim(),
    showTwitchChat: document.getElementById('chk-twitch').checked,
    twitchChannel: normalizeChannelName(document.getElementById('in-twitch-channel').value),
    kickForcePlatformColor: document.getElementById('chk-kick-platform-color').checked,
    twitchForcePlatformColor: document.getElementById('chk-twitch-platform-color').checked,
    streamlabsToken: document.getElementById('in-streamlabs-token').value.trim(),
    showChat: document.getElementById('chk-chat').checked,
    showFollows: document.getElementById('chk-follows').checked,
    showSubs: document.getElementById('chk-subs').checked,
    showGiftedSubs: document.getElementById('chk-gifted').checked,
    showTips: document.getElementById('chk-tips').checked,
    showBits: document.getElementById('chk-bits').checked,
    showRaids: document.getElementById('chk-raids').checked,
    showViewerCount: document.getElementById('chk-viewers').checked,
    showKickTimer: document.getElementById('chk-kick-timer').checked,
    showTwitchTimer: document.getElementById('chk-twitch-timer').checked,
    showNanodrops: document.getElementById('chk-nanodrops').checked,
    nanodropsFaucetId: document.getElementById('in-nanodrops-faucet').value.trim(),
    nanodropsFaucetId2: document.getElementById('in-nanodrops-faucet-2').value.trim(),
    dropDecimals: Math.max(0, Math.min(8, Number(document.getElementById('in-drop-decimals').value) || 0)),
    xnoDecimals: Math.max(0, Math.min(8, Number(document.getElementById('in-xno-decimals').value) || 0)),
    obsEnabled: document.getElementById('chk-obs').checked,
    obsWsHost: document.getElementById('in-obs-host').value.trim(),
    obsWsPort: document.getElementById('in-obs-port').value.trim(),
    obsWsPassword: document.getElementById('in-obs-password').value,
    obsMicSource: document.getElementById('in-obs-mic').value.trim(),
    obsDesktopSource: document.getElementById('in-obs-desktop').value.trim(),
    obsWebcamSource: document.getElementById('in-obs-webcam').value.trim(),
    fontSize: Number(document.getElementById('in-font-size').value),
    bgOpacity: Number(document.getElementById('in-bg-opacity').value),
    dragBarOpacity: Number(document.getElementById('in-drag-bar-opacity').value),
    clearChatGraceMs: Math.max(0, Math.round((Number(document.getElementById('in-clear-grace').value) || 0) * 1000))
  };

  // Show the cleaned-up names back in the boxes so what's saved is what's seen.
  document.getElementById('in-kick-channel').value = patch.kickChannel;
  document.getElementById('in-twitch-channel').value = patch.twitchChannel;

  // A faucet that's no longer active (changed, removed, or nanodrops switched
  // off) forgets its baseline, so if it comes back its existing history is
  // absorbed again rather than announced as new. (The main process makes the
  // matching reset for its own balance tracking.)
  const activeFaucets = patch.showNanodrops
    ? [patch.nanodropsFaucetId, patch.nanodropsFaucetId2].filter(Boolean)
    : [];
  baselinedFaucets = new Set(Array.from(baselinedFaucets).filter((id) => activeFaucets.includes(id)));
  // Same for the drop ticker: a removed/changed faucet's drops shouldn't linger.
  recentDrops = recentDrops.filter((d) => activeFaucets.includes(d.faucetId));

  settings = await overlay.setSettings(patch);
  applyAppearance(settings);

  // Switching nanodrops off stops the polling, so nothing would ever come
  // along to hide its chips and ticker – do it here.
  if (!settings.showNanodrops) {
    hideNanodropsChips();
    recentDrops = [];
  }

  if (patch.kickChannel !== prevChannel || patch.kickChatroomId !== prevChatroom) {
    startKickChat();
  }
  startViewerPolling();
  // Only reconnect to OBS if an OBS setting actually changed – reconnecting
  // briefly hides the mic/desktop/camera indicators.
  if (OBS_KEYS.some((k, i) => String(patch[k] ?? '') !== String(prevObs[i] ?? ''))) {
    connectObs();
  }
  // Reconnecting drops any chat that arrives during the gap, so only do it
  // when the Twitch settings actually changed.
  if (!!patch.showTwitchChat !== prevShowTwitch || patch.twitchChannel !== prevTwitchChannel) {
    startTwitchChat();
  }
  renderDropLine();

  closeSettings();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function init() {
  await loadSettings();
  updateLockIcon(false);

  const isFirstRun = !settings.kickChannel && !settings.streamlabsToken &&
    !(settings.showTwitchChat && settings.twitchChannel);
  if (!isFirstRun) {
    pendingLoads = new Set(['streamlabs']);
    if (settings.kickChannel) pendingLoads.add('kick');
    if (settings.showTwitchChat && settings.twitchChannel) pendingLoads.add('twitch');
    if (settings.showNanodrops) pendingLoads.add('nanodrops');
    if (settings.obsEnabled) pendingLoads.add('obs');
    updateLoadingIndicator();
  }

  overlay.onStreamlabsStatus((status) => {
    setStreamlabsStatus(status);
    markLoadDone('streamlabs');
  });
  overlay.onStreamlabsEvent(handleStreamlabsEvent);
  overlay.onClearChat(() => clearFeed());
  overlay.onNanodropsData((data) => {
    handleNanodropsData(data);
    markLoadDone('nanodrops');
  });
  overlay.onNanodropsStatus((status) => {
    handleNanodropsStatus(status);
    markLoadDone('nanodrops');
  });

  // Everything above is listening now – have main replay whatever it sent
  // while the page was still loading (see REPLAYABLE_CHANNELS in main.js).
  overlay.rendererReady();

  if (isFirstRun) {
    addLine('system', 'Welcome! Open settings (gear icon, top right) to connect your Kick channel and Streamlabs token.');
    openSettings();
  }

  startKickChat();
  startViewerPolling();
  connectObs();
  startTwitchChat();
})();
