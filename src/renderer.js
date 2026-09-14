/* global overlay */

const feedEl = document.getElementById('feed');
const settingsPanel = document.getElementById('settings-panel');
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

function addLine(type, html) {
  const wasNearBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;

  const div = document.createElement('div');
  div.className = `line ${type}`;
  div.innerHTML = html;
  feedEl.appendChild(div);

  while (feedEl.children.length > MAX_LINES) {
    feedEl.removeChild(feedEl.firstChild);
  }

  if (wasNearBottom) feedEl.scrollTop = feedEl.scrollHeight;
}

function clearFeed() {
  feedEl.innerHTML = '';
}

// ---------------------------------------------------------------------------
// Settings: load, apply, save
// ---------------------------------------------------------------------------

function applyAppearance(s) {
  document.documentElement.style.setProperty('--font-size', `${s.fontSize}px`);
  document.documentElement.style.setProperty('--bg-opacity', s.bgOpacity);
}

function populateSettingsForm(s) {
  document.getElementById('in-kick-channel').value = s.kickChannel || '';
  document.getElementById('in-kick-chatroom').value = s.kickChatroomId || '';
  document.getElementById('chk-twitch').checked = !!s.showTwitchChat;
  document.getElementById('in-twitch-channel').value = s.twitchChannel || '';
  document.getElementById('in-streamlabs-token').value = s.streamlabsToken || '';
  document.getElementById('chk-chat').checked = !!s.showChat;
  document.getElementById('chk-follows').checked = !!s.showFollows;
  document.getElementById('chk-subs').checked = !!s.showSubs;
  document.getElementById('chk-gifted').checked = !!s.showGiftedSubs;
  document.getElementById('chk-tips').checked = !!s.showTips;
  document.getElementById('chk-viewers').checked = !!s.showViewerCount;
  document.getElementById('chk-nanodrops').checked = !!s.showNanodrops;
  document.getElementById('in-nanodrops-faucet').value = s.nanodropsFaucetId || '';
  document.getElementById('in-nanodrops-faucet-2').value = s.nanodropsFaucetId2 || '';
  document.getElementById('in-drop-decimals').value = s.dropDecimals != null ? s.dropDecimals : 4;
  document.getElementById('chk-obs').checked = !!s.obsEnabled;
  document.getElementById('in-obs-host').value = s.obsWsHost || '';
  document.getElementById('in-obs-port').value = s.obsWsPort || '';
  document.getElementById('in-obs-password').value = s.obsWsPassword || '';
  document.getElementById('in-obs-mic').value = s.obsMicSource || '';
  document.getElementById('in-obs-desktop').value = s.obsDesktopSource || '';
  document.getElementById('in-obs-webcam').value = s.obsWebcamSource || '';
  document.getElementById('in-font-size').value = s.fontSize;
  document.getElementById('in-bg-opacity').value = s.bgOpacity;
  document.getElementById('btn-rebind-lock').textContent = s.lockShortcut || 'Control+Shift+L';
  document.getElementById('lock-shortcut-status').textContent = '';
  document.getElementById('btn-rebind-clear-chat').textContent = s.clearChatShortcut || 'Control+Shift+X';
  document.getElementById('clear-chat-shortcut-status').textContent = '';
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

async function fetchKickChannelInfo(slug) {
  const clean = slug.trim().toLowerCase();
  if (kickChannelInfoInFlight && kickChannelInfoInFlight.slug === clean) {
    return kickChannelInfoInFlight.promise;
  }
  const promise = (async () => {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(clean)}`, {
      headers: { Accept: 'application/json' }
    });
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

function connectKickChat(chatroomId) {
  if (kickSocket) {
    try { kickSocket.close(); } catch (_) { /* noop */ }
    kickSocket = null;
  }
  clearTimeout(kickReconnectTimer);

  if (!chatroomId) {
    setKickStatus('No chatroom configured', 'err');
    return;
  }

  setKickStatus('Connecting to chat…');
  kickSocket = new WebSocket(KICK_PUSHER_URL);

  kickSocket.onopen = () => {
    // Wait for pusher:connection_established before subscribing (handled onmessage).
  };

  kickSocket.onmessage = (raw) => {
    let envelope;
    try {
      envelope = JSON.parse(raw.data);
    } catch (_) {
      return;
    }

    if (envelope.event === 'pusher:connection_established') {
      kickSocket.send(JSON.stringify({
        event: 'pusher:subscribe',
        data: { auth: '', channel: `chatrooms.${chatroomId}.v2` }
      }));
      setKickStatus('Connected');
      return;
    }

    if (envelope.event === 'App\\Events\\ChatMessageEvent') {
      let payload;
      try { payload = JSON.parse(envelope.data); } catch (_) { return; }
      if (!settings.showChat) return;

      const sender = payload.sender || {};
      const color = (sender.identity && sender.identity.color) || '#E0DCCF';
      const badges = (sender.identity && sender.identity.badges) || [];
      addLine('chat',
        `<span class="user" style="color:${escapeHtml(color)}">${renderBadges(badges)}${escapeHtml(sender.username)}</span>: ` +
        `<span class="msg">${renderChatContent(payload.content)}</span>`
      );
      return;
    }

    // Anything else (bans, pins, mode changes, and any undocumented gift-related
    // events that occasionally ride the same socket) is logged rather than shown,
    // since alerts are handled through Streamlabs instead. Useful if you want to
    // inspect what Kick actually sends here.
    if (envelope.event && envelope.event.startsWith('App\\Events\\')) {
      console.debug('[kick] unhandled event', envelope.event, envelope.data);
    }
  };

  kickSocket.onclose = () => {
    setKickStatus('Disconnected, retrying…', 'err');
    kickReconnectTimer = setTimeout(() => connectKickChat(chatroomId), 4000);
  };

  kickSocket.onerror = () => {
    // onclose will fire right after; the reconnect is handled there.
  };
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

// Twitch's emotes tag gives UTF-16 code-unit ranges directly into the
// message text: "emoteId:start-end,start-end/emoteId2:start-end". Twitch's
// own emote CDN (static-cdn.jtvnw.net) is the same one every Twitch chat
// client hotlinks, official and third-party alike.
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

  let out = '';
  let lastIndex = 0;
  ranges.forEach(({ id, start, end }) => {
    if (start < lastIndex || end < start) return; // overlapping/bad data guard
    out += escapeHtml(text.slice(lastIndex, start));
    const name = text.slice(start, end + 1);
    out += `<img class="twitch-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/2.0" alt=":${escapeHtml(name)}:" title="${escapeHtml(name)}" loading="lazy" />`;
    lastIndex = end + 1;
  });
  out += escapeHtml(text.slice(lastIndex));
  return out;
}

function connectTwitchChat(channel) {
  if (twitchSocket) {
    try { twitchSocket.close(); } catch (_) { /* noop */ }
    twitchSocket = null;
  }
  clearTimeout(twitchReconnectTimer);

  const login = channel.trim().toLowerCase().replace(/^#/, '');
  if (!login) {
    setTwitchStatus('No channel set', 'err');
    markLoadDone('twitch');
    return;
  }

  setTwitchStatus('Connecting to chat…');
  twitchSocket = new WebSocket(TWITCH_IRC_URL);

  twitchSocket.onopen = () => {
    const anonNick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
    twitchSocket.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    twitchSocket.send('PASS SCHMOOPIIE');
    twitchSocket.send(`NICK ${anonNick}`);
    twitchSocket.send(`JOIN #${login}`);
  };

  twitchSocket.onmessage = (raw) => {
    // A single WebSocket frame can carry several IRC lines back to back.
    String(raw.data).split('\r\n').filter(Boolean).forEach((line) => {
      const msg = parseIrcLine(line);

      if (msg.command === 'PING') {
        twitchSocket.send(`PONG :${msg.trailing || 'tmi.twitch.tv'}`);
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
        // Twitch names always render in the platform's purple, regardless of
        // the viewer's own Twitch chat color, so Twitch chat is visually
        // distinct from Kick chat at a glance. Kick names keep using each
        // sender's own chosen color (see the Kick handler above).
        const color = '#c586ff';
        const badges = parseTwitchBadges(msg.tags.badges);
        addLine('chat',
          `<span class="user" style="color:${escapeHtml(color)}">${renderBadges(badges)}${escapeHtml(name)}</span>: ` +
          `<span class="msg">${renderTwitchChatContent(msg.trailing, msg.tags.emotes)}</span>`
        );
      }
    });
  };

  twitchSocket.onclose = () => {
    markLoadDone('twitch'); // don't hang the startup indicator if Twitch is unreachable
    if (!settings.showTwitchChat) return;
    setTwitchStatus('Disconnected, retrying…', 'err');
    twitchReconnectTimer = setTimeout(() => connectTwitchChat(channel), 4000);
  };

  twitchSocket.onerror = () => {
    // onclose fires right after; reconnect is handled there.
  };
}

function startTwitchChat() {
  if (twitchSocket) {
    try { twitchSocket.close(); } catch (_) { /* noop */ }
    twitchSocket = null;
  }
  clearTimeout(twitchReconnectTimer);

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

let streamLive = false;
let streamStartTime = null; // Date, or null when offline/unknown
let lastKickStartRaw = null; // last raw start_time/created_at string from Kick, for diagnostics

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
  const clockEl = document.getElementById('clock-time');
  // No explicit locale passed, so this follows the OS's own clock format
  // (12h/24h, separators, etc.) rather than assuming one region.
  if (clockEl) clockEl.textContent = new Date().toLocaleTimeString();

  const indicatorEl = document.getElementById('stream-live-indicator');
  if (indicatorEl) indicatorEl.classList.toggle('hidden', !streamLive);

  const uptimeEl = document.getElementById('stream-uptime');
  if (uptimeEl && streamLive) {
    uptimeEl.textContent = streamStartTime
      ? formatUptime(Date.now() - streamStartTime.getTime())
      : '00:00';
    // Hover the uptime to see exactly what Kick sent us and how we read it -
    // the quickest way to tell a Kick-side start-time issue apart from a
    // parsing bug on our end.
    uptimeEl.title = streamStartTime
      ? `Kick sent: ${lastKickStartRaw}\nRead as (UTC): ${streamStartTime.toISOString()}\nYour local time: ${streamStartTime.toString()}`
      : '';
  }
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

async function pollKickChannelStatus() {
  if (!settings.kickChannel) {
    streamLive = false;
    streamStartTime = null;
    document.getElementById('stat-viewers').classList.add('hidden');
    markLoadDone('kick');
    return;
  }
  try {
    const data = await fetchKickChannelInfo(settings.kickChannel);
    const live = data && data.livestream;

    streamLive = !!live;
    const startedAt = live && (live.start_time || live.created_at);
    lastKickStartRaw = startedAt || null;
    streamStartTime = startedAt ? parseKickUtcTimestamp(startedAt) : null;
    if (live) {
      console.debug('[kick] livestream start –', 'raw:', startedAt, '| read as UTC:', streamStartTime ? streamStartTime.toISOString() : null, '| now:', new Date().toISOString());
    }

    const el = document.getElementById('stat-viewers');
    const valueEl = document.getElementById('stat-viewers-value');
    if (settings.showViewerCount) {
      el.classList.remove('hidden');
      valueEl.textContent = live && live.viewer_count != null ? fmtViewers(live.viewer_count) : 'offline';
    } else {
      el.classList.add('hidden');
    }
  } catch (err) {
    console.debug('[kick] channel status poll failed', err.message);
    // Leave the last known state showing rather than flicker to an error state.
  } finally {
    markLoadDone('kick');
  }
}

function startViewerPolling() {
  clearInterval(viewerPollTimer);
  pollKickChannelStatus();
  viewerPollTimer = setInterval(pollKickChannelStatus, 30000);
}

// ---------------------------------------------------------------------------
// Streamlabs alerts (follows, subs, gifted subs, tips – Kicks & PayPal alike)
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

function logUnhandledAlert(type, source, item) {
  console.warn('[streamlabs] unhandled alert type – open devtools to inspect the payload:', type, 'for:', source, item);
}

// De-dupes on the alert's own _id/hash. Added because a real Kicks payload
// turned out to arrive via the generic "alertPlaying" event (see that case
// below) rather than through "donation" as guessed – if some alert type ever
// ends up reported through more than one of these paths at once, this stops
// it rendering twice. Items with neither field (most follows/subs) are never
// deduped, same trimming approach as seenNanoMessageIds/seenDropIds below.
let seenAlertIds = new Set();
function alreadySeenAlert(item) {
  const id = item._id || item.hash;
  if (!id) return false;
  if (seenAlertIds.has(id)) return true;
  seenAlertIds.add(id);
  if (seenAlertIds.size > 500) seenAlertIds = new Set(Array.from(seenAlertIds).slice(-250));
  return false;
}

function handleStreamlabsItem(type, item, source) {
  // Logged unconditionally: Streamlabs doesn't fully document how each
  // platform's payload differs, so this is the quickest way to check real
  // field names the first time something new comes in.
  console.debug('[streamlabs]', type, 'for:', source, item);

  const name = escapeHtml(item.name || item.from || 'Someone');
  if (alreadySeenAlert(item)) return;

  switch (type) {
    case 'follow':
      if (!settings.showFollows) return;
      addLine('follow', `<span class="tag">FOLLOW</span><span class="user">${name}</span> followed`);
      return;

    case 'subscription': {
      const isGift = !!(item.gifter || item.is_gift || item.giftedFrom);
      if (isGift) {
        if (!settings.showGiftedSubs) return;
        const gifter = escapeHtml(item.gifter || item.giftedFrom || 'Someone');
        addLine('giftedsub',
          `<span class="tag">GIFTED SUB</span><span class="user">${gifter}</span> gifted a sub to ` +
          `<span class="user">${name}</span>`
        );
      } else {
        if (!settings.showSubs) return;
        const months = item.months || item.streak_months;
        addLine('sub',

          `<span class="tag">SUB</span><span class="user">${name}</span> subscribed` +
          (months ? ` <span class="amount">(${escapeHtml(String(months))} mo)</span>` : '')
        );
      }
      return;
    }

    case 'donation': {
      if (!settings.showTips) return;
      const amount = escapeHtml(formatAmount(item));
      const msg = item.message ? `: <span class="msg">${escapeHtml(item.message)}</span>` : '';

      // The previous "for"-based Kicks guess here is gone: a real Kicks
      // payload came through as type "alertPlaying" (handled below), not as
      // "donation" with for: "kick_account" as guessed. So anything landing
      // here is the classic tip-page donation, which for most streamers
      // means PayPal.
      const isPaypal = !source || source.toLowerCase() === 'streamlabs';
      const label = isPaypal ? 'PAYPAL TIP' : 'TIP';
      const variant = isPaypal ? 'tip-paypal' : '';

      addLine(`tip ${variant}`.trim(),
        `<span class="tag">${label}</span><span class="user">${name}</span> ` +
        `sent <span class="amount">${amount}</span>${msg}`
      );
      return;
    }

    // Confirmed from a real payload: Streamlabs fires "alertPlaying" for
    // whatever's currently showing in the alert box, and Kicks-platform
    // alerts arrive here with item.type === "kicks" / item.platform ===
    // "kick_account" nested inside, not as their own top-level "kicks" /
    // "kick_tip" / "kickTip" type as previously guessed – those guesses are
    // gone. Only the Kicks shape is handled here; other "alertPlaying" items
    // (the same follow/sub/tip alerts already handled by their own case
    // above, replaying through this generic firehose) fall through to the
    // unhandled-alert log instead of risking a duplicate line.
    case 'alertPlaying': {
      if (item.type !== 'kicks' && item.platform !== 'kick_account') {
        logUnhandledAlert(type, source, item);
        return;
      }
      if (!settings.showTips) return;

      // The one real payload seen so far had kickType "LEVEL_UP" – Kick's
      // loyalty-rank notification, not a fresh tip. Its "amount" reads like
      // a cumulative Kicks total for the tier rather than a one-off gift, so
      // it gets its own wording. Worth checking devtools next time an actual
      // Kicks tip lands, to see what kickType (if any) that one carries.
      if (item.kickType === 'LEVEL_UP') {
        const level = escapeHtml(item.levelName || 'a new rank');
        addLine('tip tip-kicks',
          `<span class="tag">KICKS</span><span class="user">${name}</span> reached <span class="amount">${level}</span>`
        );
        return;
      }

      const amount = escapeHtml(formatAmount(item));
      const msg = item.message ? `: <span class="msg">${escapeHtml(item.message)}</span>` : '';
      addLine('tip tip-kicks',
        `<span class="tag">KICKS</span><span class="user">${name}</span> sent <span class="amount">${amount}</span>${msg}`
      );
      return;
    }

    default:
      // Unrecognized alert type – left out of the feed but visible in devtools
      // console (see the unconditional console.debug above) for calibration.
      logUnhandledAlert(type, source, item);
      return;
  }
}

function handleStreamlabsEvent(eventData) {
  if (!eventData || !eventData.type) return;
  const items = Array.isArray(eventData.message) ? eventData.message : [eventData.message];
  items.filter(Boolean).forEach((item) => handleStreamlabsItem(eventData.type, item, eventData.for));
}

// ---------------------------------------------------------------------------
// NanoDrops stats – fetched and computed in the main process; renderer just
// formats and displays whatever arrives.
// ---------------------------------------------------------------------------

function fmtXno(n) {
  return n == null ? '–' : `<span class="accent">Ӿ</span>${Number(n).toFixed(2)}`;
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
let nanoMessagesInitialized = false;

// ---------------------------------------------------------------------------
// Drop ticker – a static (non-scrolling) line under the stats line showing
// the faucet's raw drop log (viewer, amount, streamer – no message text).
// It sits empty/hidden until the first new drop lands, then always shows the
// most recent drops, oldest-of-the-visible-set on the left, dropping older
// ones off as needed to keep the line from overflowing the window.
// ---------------------------------------------------------------------------

let seenDropIds = new Set();
let dropsInitialized = false;
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

  if (recentDrops.length === 0) {
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

function handleNanodropsDrops(drops) {
  if (!Array.isArray(drops) || drops.length === 0) return;

  if (!dropsInitialized) {
    // Don't flood the line with the faucet's existing drop history on
    // first load – only show ones that land after the app has started.
    drops.forEach((d) => seenDropIds.add(d.id));
    dropsInitialized = true;
    return;
  }

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

function handleNanodropsMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return;

  if (!nanoMessagesInitialized) {
    // Don't replay the faucet's existing message history on first load –
    // only show ones that arrive after the app has started, like live chat.
    messages.forEach((m) => seenNanoMessageIds.add(m.id));
    nanoMessagesInitialized = true;
    return;
  }

  messages.forEach((m) => {
    if (seenNanoMessageIds.has(m.id)) return;
    seenNanoMessageIds.add(m.id);
    if (!settings.showNanodrops) return;

    const amountXno = m.amount && m.amount.xno != null ? Number(m.amount.xno) : null;
    // "tip" = a direct viewer-to-viewer/streamer tip; anything else (kind is
    // null for these) is a contribution into the faucet pool itself.
    const isDirectTip = m.kind === 'tip';
    const tag = isDirectTip ? 'NANO' : 'JUICED';
    const verb = isDirectTip ? 'tipped' : 'juiced the faucet with';
    addLine(isDirectTip ? 'nanotip' : 'nanotip nanotip-faucet',
      `<span class="tag">${tag}</span><span class="user">${escapeHtml(m.name || 'Someone')}</span> ` +
      `${verb} <span class="amount">${fmtXno(amountXno)}</span>` +
      (m.text ? `: <span class="msg">${escapeHtml(m.text)}</span>` : '')
    );
  });

  if (seenNanoMessageIds.size > 500) {
    seenNanoMessageIds = new Set(Array.from(seenNanoMessageIds).slice(-250));
  }
}

function handleNanodropsData(data) {
  if (!data) return;
  setNanodropsStat('stat-nd-watchers', data.streamWatchers != null, String(data.streamWatchers));
  setNanodropsStat('stat-nd-rate', data.hourlyRateUsd != null, fmtUsd(data.hourlyRateUsd));
  setNanodropsStat('stat-nd-faucet', data.faucetBalanceXno != null, fmtXno(data.faucetBalanceXno));
  handleNanodropsPool(data.networkActiveNanoXno, data.networkActiveUsers);
  handleNanodropsMessages(data.messages);
  handleNanodropsDrops(data.drops);
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

function handleNanodropsStatus(status) {
  const el = document.getElementById('nanodrops-status');
  if (!el) return;
  el.textContent = status.message;
  el.className = `status ${status.ok ? 'ok' : 'err'}`;
  if (!status.ok) {
    ['stat-nd-watchers', 'stat-nd-rate', 'stat-nd-faucet', 'stat-nd-pool']
      .forEach((id) => document.getElementById(id)?.classList.add('hidden'));
    recentDrops = [];
    const track = document.getElementById('drop-ticker-track');
    if (track) track.innerHTML = '';
    document.getElementById('drop-ticker')?.classList.add('hidden');
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

function applyObsMuteState(inputName, muted) {
  if (!inputName) return;
  if (inputName === settings.obsMicSource) setObsStatusChips(['drag-obs-mic'], !muted);
  if (inputName === settings.obsDesktopSource) setObsStatusChips(['drag-obs-desktop'], !muted);
}

function applyObsCameraState(visible) {
  setObsStatusChips(['drag-obs-camera'], !!visible);
}

// Shows/hides the two meter columns independently (only if that source is
// configured) and the whole sidebar (only if OBS is enabled and at least one
// of them is set) – same pattern as the mic/desktop/camera chips above.
function updateObsMetersVisibility() {
  const showMic = !!(settings.obsEnabled && settings.obsMicSource);
  const showDesktop = !!(settings.obsEnabled && settings.obsDesktopSource);
  document.getElementById('meter-mic')?.classList.toggle('hidden', !showMic);
  document.getElementById('meter-desktop')?.classList.toggle('hidden', !showDesktop);
  document.getElementById('obs-meters')?.classList.toggle('hidden', !(showMic || showDesktop));
}

// obs-websocket reports levels as a linear multiplier (0 and up, >1 means
// clipping), not dB, so it's converted here to match how OBS's own meter
// reads: -60dB floor (silence) to 0dB ceiling, mapped to a 0–1 fill
// fraction. Colour bands (green/yellow/red) mirror OBS's meter too.
function setMeterLevel(colId, mul) {
  const fill = document.querySelector(`#${colId} .meter-fill`);
  if (!fill) return;
  const db = mul > 0 ? 20 * Math.log10(mul) : -100;
  const frac = Math.max(0, Math.min(1, (Math.max(-60, db) + 60) / 60));
  fill.style.transform = `scaleY(${frac})`;
  fill.classList.toggle('lvl-red', db >= -3);
  fill.classList.toggle('lvl-yellow', db >= -12 && db < -3);
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
    try { obsSocket.close(); } catch (_) { /* noop */ }
    obsSocket = null;
  }
  clearTimeout(obsReconnectTimer);
  obsPendingMuteRequests.clear();
  obsWebcamSceneName = null;
  obsWebcamItemId = null;

  hideObsChips(['drag-obs-mic', 'drag-obs-desktop', 'drag-obs-camera']);
  updateObsMetersVisibility();
  setMeterLevel('meter-mic', 0);
  setMeterLevel('meter-desktop', 0);

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
        // General(1) + Scenes(4) + Inputs(8) + SceneItems(128) + the
        // high-volume InputVolumeMeters(65536) category, which drives the
        // mic/desktop bars and is opt-in since obs-websocket excludes it
        // from "All" by default.
        d: { rpcVersion: 1, authentication, eventSubscriptions: 65677 }
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

      // High-volume event, ~20/sec while subscribed – covered in the "OBS
      // adds too much latency?" sense by updating via a GPU-composited
      // transform (see .meter-fill) rather than anything layout-triggering.
      if (eventType === 'InputVolumeMeters' && Array.isArray(eventData.inputs)) {
        eventData.inputs.forEach((inp) => {
          // First channel only (mono meter is enough for a level bar);
          // index 0 of that channel's triplet is the current level – 1/2
          // are peak/peak-hold, not needed here.
          const channel = inp.inputLevelsMul && inp.inputLevelsMul[0];
          if (!channel) return;
          const mul = channel[0];
          if (inp.inputName === settings.obsMicSource) setMeterLevel('meter-mic', mul);
          if (inp.inputName === settings.obsDesktopSource) setMeterLevel('meter-desktop', mul);
        });
      }
    }
  };

  obsSocket.onclose = () => {
    markLoadDone('obs'); // don't hang the startup indicator if OBS isn't running
    if (!settings.obsEnabled) return;
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
  'PageDown': 'PageDown'
};

// Turns a keydown event into an Electron accelerator string, e.g. "Control+Shift+L"
// or a bare key like "F20". Returns { pending: true } while only modifier
// keys are held, or { accelerator } once it's a valid combo.
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
  else if (key.length === 1) mainKey = key.toUpperCase();
  else mainKey = key;

  return { accelerator: [...mods, mainKey].join('+') };
}

// Wires up one "click, then press a key combo" rebind button. Shared by the
// lock shortcut and the clear-chat shortcut below rather than duplicated,
// since the two work identically apart from which setting/IPC call they use.
function setupShortcutRebind({ buttonId, statusId, settingsKey, defaultAccelerator, setShortcut }) {
  const btn = document.getElementById(buttonId);
  let capturing = false;

  function setStatus(text, cls) {
    const el = document.getElementById(statusId);
    if (el) {
      el.textContent = text;
      el.className = `status ${cls || ''}`.trim();
    }
  }

  function startCapture() {
    capturing = true;
    btn.textContent = 'Press a key combination…';
    btn.classList.add('capturing');
    setStatus('');
  }

  function stopCapture(displayText) {
    capturing = false;
    btn.classList.remove('capturing');
    btn.textContent = displayText;
  }

  btn.addEventListener('click', () => {
    if (!capturing) startCapture();
  });

  btn.addEventListener('keydown', async (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();

    const fallback = settings[settingsKey] || defaultAccelerator;

    if (e.key === 'Escape') {
      stopCapture(fallback);
      return;
    }

    const result = captureKeyToAccelerator(e);
    if (result.pending) return;
    if (result.error) {
      setStatus(result.error, 'err');
      return;
    }

    btn.textContent = result.accelerator;
    const res = await setShortcut(result.accelerator);
    if (res.ok) {
      settings[settingsKey] = res.accelerator;
      stopCapture(res.accelerator);
      setStatus('Saved.', 'ok');
    } else {
      stopCapture(res.accelerator || fallback);
      setStatus(`Could not bind ${result.accelerator} – already in use by something else.`, 'err');
    }
  });

  btn.addEventListener('blur', () => {
    if (capturing) stopCapture(settings[settingsKey] || defaultAccelerator);
  });
}

setupShortcutRebind({
  buttonId: 'btn-rebind-lock',
  statusId: 'lock-shortcut-status',
  settingsKey: 'lockShortcut',
  defaultAccelerator: 'Control+Shift+L',
  setShortcut: (accelerator) => overlay.setLockShortcut(accelerator)
});

setupShortcutRebind({
  buttonId: 'btn-rebind-clear-chat',
  statusId: 'clear-chat-shortcut-status',
  settingsKey: 'clearChatShortcut',
  defaultAccelerator: 'Control+Shift+X',
  setShortcut: (accelerator) => overlay.setClearChatShortcut(accelerator)
});

// Shows a faint outline around the window's true bounds while it has focus,
// since it's otherwise fully transparent and easy to lose track of.
overlay.onWindowFocusChanged((focused) => {
  document.body.classList.toggle('window-focused', focused);
});

overlay.onOpenSettings(() => openSettings());
overlay.onClearChat(() => clearFeed());

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

document.getElementById('btn-save').addEventListener('click', async () => {
  const prevChannel = settings.kickChannel;
  const prevChatroom = settings.kickChatroomId;

  const patch = {
    kickChannel: document.getElementById('in-kick-channel').value.trim(),
    kickChatroomId: document.getElementById('in-kick-chatroom').value.trim(),
    showTwitchChat: document.getElementById('chk-twitch').checked,
    twitchChannel: document.getElementById('in-twitch-channel').value.trim(),
    streamlabsToken: document.getElementById('in-streamlabs-token').value.trim(),
    showChat: document.getElementById('chk-chat').checked,
    showFollows: document.getElementById('chk-follows').checked,
    showSubs: document.getElementById('chk-subs').checked,
    showGiftedSubs: document.getElementById('chk-gifted').checked,
    showTips: document.getElementById('chk-tips').checked,
    showViewerCount: document.getElementById('chk-viewers').checked,
    showNanodrops: document.getElementById('chk-nanodrops').checked,
    nanodropsFaucetId: document.getElementById('in-nanodrops-faucet').value.trim(),
    nanodropsFaucetId2: document.getElementById('in-nanodrops-faucet-2').value.trim(),
    dropDecimals: Math.max(0, Math.min(8, Number(document.getElementById('in-drop-decimals').value) || 0)),
    obsEnabled: document.getElementById('chk-obs').checked,
    obsWsHost: document.getElementById('in-obs-host').value.trim(),
    obsWsPort: document.getElementById('in-obs-port').value.trim(),
    obsWsPassword: document.getElementById('in-obs-password').value,
    obsMicSource: document.getElementById('in-obs-mic').value.trim(),
    obsDesktopSource: document.getElementById('in-obs-desktop').value.trim(),
    obsWebcamSource: document.getElementById('in-obs-webcam').value.trim(),
    fontSize: Number(document.getElementById('in-font-size').value),
    bgOpacity: Number(document.getElementById('in-bg-opacity').value)
  };

  settings = await overlay.setSettings(patch);
  applyAppearance(settings);

  if (patch.kickChannel !== prevChannel || patch.kickChatroomId !== prevChatroom) {
    startKickChat();
  }
  startViewerPolling();
  connectObs();
  startTwitchChat();
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
  overlay.onNanodropsData((data) => {
    handleNanodropsData(data);
    markLoadDone('nanodrops');
  });
  overlay.onNanodropsStatus((status) => {
    handleNanodropsStatus(status);
    markLoadDone('nanodrops');
  });

  if (isFirstRun) {
    addLine('system', 'Welcome! Open settings (gear icon, top right) to connect your Kick channel and Streamlabs token.');
    openSettings();
  }

  startKickChat();
  startViewerPolling();
  connectObs();
  startTwitchChat();
})();
