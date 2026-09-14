# Kick Stream Overlay

A transparent, always-on-top desktop overlay (same idea as [Transparent-Twitch-Chat-Overlay](https://github.com/baffler/Transparent-Twitch-Chat-Overlay), rebuilt for Kick) that shows:

- Live Kick chat, connected directly to Kick (no auth needed)
- Follows, subs, gifted subs, and tips (Kicks **and** PayPal), via Streamlabs

It's an Electron app rather than WPF, so it runs the same way on Windows and is one project instead of two (native app + web renderer).

## Why Streamlabs for alerts

Kick's own public API has webhooks for chat, follows, and subs/gifted subs, but not (yet) an official event for Kicks-gift tips. Streamlabs already has a working Kick integration that normalizes follows/subs/tips into one alert feed — including Kicks and PayPal tips — so this app leans on that instead of reverse-engineering Kick's internal gift events. Chat still connects straight to Kick, since that part **is** solid and doesn't need a middleman.

## Setup

1. Install [Node.js](https://nodejs.org) (LTS) if you don't have it.
2. In this folder, run:
   ```
   npm install
   npm start
   ```
3. Click the gear icon (top-right of the overlay) and fill in:
   - **Kick channel slug** — your channel's URL slug (e.g. `stouty` for kick.com/stouty).
   - **Streamlabs Socket API token** — from [streamlabs.com](https://streamlabs.com) → Dashboard → Settings → API Tokens → "Your Socket API Token". This is tied to whichever account you're logged into on Streamlabs, so make sure that's your Kick-linked one.
4. Hit **Save & reconnect**.
5. Drag the thin top strip to position the window, resize from the bottom-right corner, then press **Ctrl+Shift+L** to lock it into click-through mode so it stops eating mouse clicks over your game. Press it again to unlock and reposition later. **Ctrl+Shift+O** reopens settings any time (works even while locked).

If the chatroom auto-detect fails (Kick occasionally Cloudflare-blocks the lookup from some IPs), open `https://kick.com/api/v2/channels/<your-slug>` in a normal browser tab, find `"chatroom": { "id": ... }`, and paste that number into the "Chatroom ID" field manually.

## Emotes

Kick sends emotes inline as text tokens like `[emote:1730753:emojiAngry]` rather than as a separate array, so the app parses those out of each message and renders them as images from `files.kick.com/emotes/<id>/fullsize`. Everything else in the message is still escaped as plain text.

## One thing to verify live

Streamlabs doesn't publicly document exactly how a Kicks tip payload differs from a PayPal tip payload. Based on their documented pattern for other platforms (Twitch events arrive tagged `for: "twitch_account"`, YouTube as `for: "youtube_account"`, etc., while the classic tip-page donation has historically arrived with `for` absent or set to `"streamlabs"`), the app guesses:

- `for` contains `"kick"` → labeled **KICKS TIP** (green)
- `for` missing or `"streamlabs"` → labeled **PAYPAL TIP** (blue)
- anything else → generic **TIP**

This is an educated guess from the naming convention, not a confirmed payload. Every donation is logged raw to the DevTools console (`Ctrl+Shift+I` → Console) regardless of label, so send yourself one small tip of each type once you're able to and check the `for` field there. If it doesn't match, the fix is one line in `handleStreamlabsItem()` in `src/renderer.js` — the `src.includes('kick')` / `!source || src === 'streamlabs'` checks.

## Live viewer count

Toggled on by default in Settings → "Show in feed" → "Live viewer count". It reuses the same `kick.com/api/v2/channels/<slug>` lookup already used for chat, polling every 30 seconds, and shows in a thin stats bar above the chat feed. Shows "offline" when you're not live.

## nanodrops stats

Uses the two public endpoints Immi confirmed:
- `nanodrops.org/api/faucets/<faucetId>` — your stream's own faucet: watchers and current balance.
- `nanodrops.org/api/stats` — network-wide: total active viewers, total active balance, and the current hourly earn rate (converted to USD using the endpoint's own `usdPerXno`).

Your faucet ID (`a4552cef`) is already filled in as the default in Settings → nanodrops. Both endpoints are fetched from the main process rather than the browser page, so there's no CORS concern the way there was with the signed viewer-session API. Polls every 15 seconds; toggle the whole thing off in Settings → "Show in feed" → "nanodrops stats".

With two faucet IDs set (e.g. a Kick faucet and a Twitch faucet), watcher counts are summed, but the faucet balance shown is **not** a combined total. Each faucet response reports whether its stream is currently online; a faucet that's offline has its balance left out entirely. If only one of the two is online, that one's balance is shown on its own. If both are online, the bigger of the two balances is shown. If both are offline, no faucet balance is shown at all.

The faucet endpoint also returns any TTS messages viewers left with a drop (the same ones nanodrops reads out loud) — new ones appear in the chat feed as a "NANO DROP" line alongside chat and Streamlabs alerts. Only new messages show (the existing history isn't replayed on startup), same as live chat.

The stats bar uses icons rather than text labels to stay compact: green head = Kick viewers, blue head = viewers watching via nanodrops, drop = your faucet balance, eye = total balance and total viewers network-wide (shown together, e.g. `👁 Ӿ2.21/4`). Hover any of them for a tooltip.

## Building a standalone .exe

Once you're happy with it:
```
npm run dist
```
This uses `electron-builder` to produce a Windows installer in `dist/`. Run this on a Windows machine (or with wine configured) since it's building a native Windows target.

## Hotkeys

| Keys | Action |
|---|---|
| Ctrl+Shift+L | Toggle click-through lock |
| Ctrl+Shift+O | Open settings panel |

## Project layout

```
main.js          Electron main process: window, tray, hotkeys, Streamlabs socket
preload.js       Safe bridge between main and renderer
src/index.html   Overlay + settings panel markup
src/style.css    Overlay theme (legible over arbitrary game backgrounds)
src/renderer.js  Kick chat websocket, Streamlabs event handling, feed rendering
```
