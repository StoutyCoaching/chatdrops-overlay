'use strict';

// Kick chat client.
//
// Kick stopped serving chat over Pusher in October 2026 and moved it to its own
// Centrifugo server. Connecting takes three steps (details from the unofficial
// kicksdk crate's notes on Kick's behaviour):
//
//   1. POST web.kick.com/api/v1/realtime/channels/<channelId>/chat/connection
//      -> which Centrifugo server carries this channel's chat.
//   2. POST web.kick.com/api/v1/realtime/auth/connection
//      -> a guest token (valid ~45 minutes, refreshed in place before then).
//   3. Open a WebSocket to that server and speak Centrifugo's JSON protocol:
//      connect with the token, subscribe to chatrooms.<chatroomId>.v2, answer
//      the server's `{}` pings with `{}`, and refresh the token before it runs out.
//
// Kick only accepts these requests - and the WebSocket handshake - with an Origin
// of https://kick.com, which is why this runs in the main process: a web page
// can't set that header, the main process can.
//
// Events reach the caller in the same shape the old Pusher feed used:
// { event: 'App\\Events\\ChatMessageEvent', data: '<json string>' }.

const crypto = require('crypto');

const REALTIME_BASE = 'https://web.kick.com/api/v1/realtime';
const REQUIRED_ORIGIN = 'https://kick.com';

const DEFAULTS = {
  backoffStartMs: 1000, // wait before the first retry...
  backoffMaxMs: 30000, // ...doubling up to this
  pingMs: 25000, // Kick's ping interval until the server says otherwise
  silenceGraceMs: 20000, // how long past a missed ping before the link counts as dead
  refreshLeadMs: 120000, // ask for a fresh token this long before the old one expires
  tickMs: 5000, // how often the silence / refresh checks run
  handshakeTimeoutMs: 15000
};

// Parses {"data": {...}, "message": "..."} answers; throws a readable Error.
function parseAnswer(res) {
  if (!res || res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res ? res.status : 'no response'}`);
  }
  let json;
  try {
    json = JSON.parse(res.body);
  } catch (_) {
    throw new Error('unreadable answer from Kick');
  }
  if (!json || typeof json.data !== 'object' || json.data === null) {
    throw new Error('unexpected answer from Kick');
  }
  return json.data;
}

// Picks the Centrifugo server URL out of a connection answer.
function pickCentrifugoUrl(data) {
  const list = Array.isArray(data.connections) ? data.connections : [];
  const hit = list.find((c) => c && c.provider === 'centrifugo' && c.credentials && c.credentials.url);
  if (!hit) {
    const seen = list.map((c) => (c && c.provider) || '?').join(', ') || 'none';
    throw new Error(`Kick offered no chat server this app can use (offered: ${seen})`);
  }
  return hit.credentials.url;
}

// options:
//   httpPost(url, bodyObject) -> Promise<{ status, body }>   (sets Origin/Referer)
//   WebSocketImpl             -> the `ws` package's WebSocket class
//   onEvent({ event, data, channel })
//   onStatus(text, cls)       -> cls is 'err' or ''
//   log(...)                  -> optional diagnostics
//   userAgent                 -> optional User-Agent for the WebSocket handshake
//   timings                   -> optional overrides of DEFAULTS (used by tests)
function createKickChat(options) {
  const { httpPost, WebSocketImpl, onEvent, onStatus } = options;
  const log = options.log || (() => {});
  const t = { ...DEFAULTS, ...(options.timings || {}) };

  let generation = 0; // bumped by start()/stop(); retires anything left from an older run
  let target = null; // { channelId, chatroomId }
  let reconnectTimer = null;
  let backoffMs = t.backoffStartMs;

  let session = null; // the live connection's state, or null

  function status(text, cls) {
    try { onStatus(text, cls || ''); } catch (_) { /* never let the UI break the client */ }
  }

  function clearSession() {
    if (!session) return;
    clearInterval(session.tickTimer);
    session = null;
  }

  function scheduleReconnect(gen, why) {
    if (gen !== generation) return;
    clearTimeout(reconnectTimer);
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, t.backoffMaxMs);
    log('retrying in', delay, 'ms –', why);
    reconnectTimer = setTimeout(() => connect(gen), delay);
  }

  async function lookUpServerUrl(clientId) {
    const body = { client: { id: clientId, type: 'web' }, capabilities: { accepted_providers: [{ provider: 'centrifugo' }] } };
    const path = target.channelId ? `/channels/${encodeURIComponent(target.channelId)}/chat/connection` : '/connection';
    return pickCentrifugoUrl(parseAnswer(await httpPost(REALTIME_BASE + path, body)));
  }

  async function fetchToken(clientId) {
    const data = parseAnswer(await httpPost(`${REALTIME_BASE}/auth/connection`, { client_id: clientId }));
    if (!data.token) throw new Error('no connection token from Kick');
    return String(data.token);
  }

  async function connect(gen) {
    if (gen !== generation || !target) return;
    status('Connecting to chat…');
    const clientId = crypto.randomUUID();
    let url;
    let token;
    try {
      url = await lookUpServerUrl(clientId);
      token = await fetchToken(clientId);
    } catch (err) {
      if (gen !== generation) return;
      log('setup failed:', err.message);
      status(`Can't reach Kick chat (${err.message}) – retrying…`, 'err');
      scheduleReconnect(gen, err.message);
      return;
    }
    if (gen !== generation) return;
    openSocket(gen, url, token, clientId);
  }

  function openSocket(gen, url, token, clientId) {
    const wsOptions = {
      origin: REQUIRED_ORIGIN,
      handshakeTimeout: t.handshakeTimeoutMs,
      headers: options.userAgent ? { 'User-Agent': options.userAgent } : {}
    };
    let ws;
    try {
      ws = new WebSocketImpl(url, wsOptions);
    } catch (err) {
      status(`Can't reach Kick chat (${err.message}) – retrying…`, 'err');
      scheduleReconnect(gen, err.message);
      return;
    }

    const s = {
      ws,
      clientId,
      phase: 'connecting', // connecting -> connected -> closing
      nextId: 0,
      pending: new Map(), // command id -> 'connect' | 'refresh' | 'subscribe:<channel>'
      pingMs: t.pingMs,
      lastTraffic: Date.now(),
      refreshAt: null,
      refreshAsked: false,
      subscribed: false,
      tickTimer: null
    };
    session = s;
    const alive = () => gen === generation && session === s;

    function send(text) {
      try { ws.send(text); } catch (_) { /* the close handler deals with a dead socket */ }
    }

    function command(kind, body) {
      s.nextId += 1;
      s.pending.set(s.nextId, kind);
      return JSON.stringify({ id: s.nextId, ...body });
    }

    function closeSocket(reason, message, cls) {
      if (s.phase === 'closing') return;
      s.phase = 'closing';
      log('closing:', reason);
      if (message) status(message, cls || 'err');
      try { ws.terminate ? ws.terminate() : ws.close(); } catch (_) { /* already gone */ }
    }

    function schedule(reply) {
      const ping = Number(reply && reply.ping);
      if (ping > 0) s.pingMs = ping * 1000;
      const ttlMs = (Number(reply && reply.ttl) || 0) * 1000;
      s.refreshAsked = false;
      s.refreshAt = reply && reply.expires && ttlMs > 0
        ? Date.now() + Math.max(ttlMs - t.refreshLeadMs, ttlMs / 2)
        : null;
    }

    function handleReply(id, msg) {
      const kind = s.pending.get(id);
      if (!kind) return;
      s.pending.delete(id);
      const err = msg.error ? `${msg.error.code} ${msg.error.message || ''}`.trim() : null;

      if (kind === 'connect') {
        if (err) {
          closeSocket('connect refused', `Kick refused the chat connection (${err}) – retrying…`);
          return;
        }
        s.phase = 'connected';
        schedule(msg.connect);
        send(command(`subscribe:chatrooms.${target.chatroomId}.v2`, {
          subscribe: { channel: `chatrooms.${target.chatroomId}.v2` }
        }));
      } else if (kind === 'refresh') {
        if (err) closeSocket('token refresh refused', `Kick refused a new chat token (${err}) – retrying…`);
        else schedule(msg.refresh);
      } else if (kind.startsWith('subscribe:')) {
        if (err) {
          closeSocket('subscribe refused', `Kick refused the chat subscription (${err}) – retrying…`);
        } else {
          s.subscribed = true;
          backoffMs = t.backoffStartMs; // a working connection resets the retry delay
          status('Connected');
        }
      }
    }

    function handlePush(push) {
      if (push.disconnect) {
        const d = push.disconnect;
        closeSocket('server disconnect', `Kick ended the chat connection (${d.code} ${d.reason || ''}`.trim() + ') – retrying…');
      } else if (push.unsub) {
        closeSocket('unsubscribed', 'Kick removed the chat subscription – retrying…');
      } else if (push.pub && push.pub.data && typeof push.pub.data.event === 'string') {
        onEvent({ event: push.pub.data.event, data: push.pub.data.data, channel: push.channel || '' });
      }
    }

    function handleText(text) {
      s.lastTraffic = Date.now();
      for (const raw of String(text).split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line === '{}') { send('{}'); continue; } // the server's ping: answer with a pong
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (!msg || typeof msg !== 'object') continue;
        if (msg.id > 0) handleReply(msg.id, msg);
        else if (msg.push) handlePush(msg.push);
        if (s.phase === 'closing') break;
      }
    }

    ws.on('open', () => {
      if (!alive()) return;
      s.lastTraffic = Date.now();
      send(command('connect', { connect: { token, name: 'js' } }));
    });

    ws.on('message', (data) => {
      if (!alive()) return;
      handleText(typeof data === 'string' ? data : data.toString());
    });

    ws.on('error', (err) => {
      if (!alive()) return;
      // 'close' follows and handles the retry; this is only for the log and,
      // when Kick rejects the handshake outright, a clearer status message.
      log('socket error:', err && err.message);
      const m = /Unexpected server response: (\d+)/.exec((err && err.message) || '');
      s.failure = m ? `Kick rejected the chat connection (HTTP ${m[1]})` : null;
    });

    ws.on('close', () => {
      if (gen !== generation) return;
      const wasCurrent = session === s;
      if (wasCurrent) clearSession();
      if (!wasCurrent) return;
      if (s.failure) status(`${s.failure} – retrying…`, 'err');
      else if (s.phase !== 'closing') status('Disconnected, retrying…', 'err');
      scheduleReconnect(gen, 'socket closed');
    });

    // Silence + token-refresh checks.
    s.tickTimer = setInterval(() => {
      if (!alive() || s.phase === 'closing') return;
      const now = Date.now();
      if (now - s.lastTraffic > s.pingMs + t.silenceGraceMs) {
        closeSocket('went quiet', 'Kick chat went quiet – reconnecting…');
        return;
      }
      if (s.phase === 'connected' && s.refreshAt && !s.refreshAsked && now >= s.refreshAt) {
        s.refreshAsked = true;
        fetchToken(s.clientId)
          .then((fresh) => { if (alive() && s.phase === 'connected') send(command('refresh', { refresh: { token: fresh } })); })
          .catch((err) => log('token refresh failed:', err.message)); // Kick ends the link when the old token expires; the reconnect gets a new one
      }
    }, t.tickMs);
  }

  return {
    // Connects (or reconnects) for this channel/chatroom. channelId is optional:
    // without it Kick's general server is asked for instead of the channel's own.
    start(next) {
      generation += 1;
      clearTimeout(reconnectTimer);
      if (session) {
        const old = session;
        clearSession();
        try { old.ws.terminate ? old.ws.terminate() : old.ws.close(); } catch (_) { /* noop */ }
      }
      backoffMs = t.backoffStartMs;
      target = { channelId: next.channelId ? String(next.channelId) : '', chatroomId: String(next.chatroomId) };
      connect(generation);
    },
    stop() {
      generation += 1;
      target = null;
      clearTimeout(reconnectTimer);
      if (session) {
        const old = session;
        clearSession();
        try { old.ws.terminate ? old.ws.terminate() : old.ws.close(); } catch (_) { /* noop */ }
      }
    }
  };
}

module.exports = { createKickChat, REQUIRED_ORIGIN, REALTIME_BASE };
