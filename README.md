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
5. Drag the thin top strip to position the window, resize from the bottom-right corner, then press **Ctrl+Shift+L** to lock it into click-through mode so it stops eating mouse clicks over your game. Press it again to unlock and reposition later. To reopen settings while locked, use the tray icon's "Open Settings" entry.

If the chatroom auto-detect fails (Kick occasionally Cloudflare-blocks the lookup from some IPs), open `https://kick.com/api/v2/channels/<your-slug>` in a normal browser tab, find `"chatroom": { "id": ... }`, and paste that number into the "Chatroom ID" field manually.

## Emotes

Kick sends emotes inline as text tokens like `[emote:1730753:emojiAngry]` rather than as a separate array, so the app parses those out of each message and renders them as images from `files.kick.com/emotes/<id>/fullsize`. Everything else in the message is still escaped as plain text.

## Kicks tips & gifted-sub bombs

Confirmed from a live payload: Kicks tips (and Kick's multi-sub gifting) don't arrive as a normal `donation`/`subscription` top-level event. Streamlabs wraps them in a generic `alertPlaying` envelope instead, with the real type/platform nested inside the item itself (`item.type: "kicks"`, `item.platform: "kick_account"`). `handleStreamlabsEvent()` in `src/renderer.js` now unwraps that envelope — when the top-level type is `alertPlaying`, it routes on `item.type`/`item.platform` instead — which is what fixed both the missing KICKS tips and the missing multi-gifted-sub alerts (single gifted subs already arrived as a normal `subscription` event, so those worked before).

A Kicks tip now shows as **KICKS** with the amount, followed by the level name in brackets when Streamlabs includes one, e.g. `KICKS UmbreIla sent 1 (Hell Yeah)`. Kick's multi-sub gift bombs arrive the same wrapped way, as a `communityGift` item with a `massSubGiftChildAlerts` array — one entry per recipient — so those now show as `GIFTED SUB <gifter> gifted 5 subs to <name1>, <name2>, …` (capped at 8 names, with a "+N more" tail for bigger bombs). Every donation is still logged raw to the DevTools console (`Ctrl+Shift+I` → Console) regardless of label, so if a future payload shape doesn't match, check it there — the relevant code is `handleStreamlabsEvent()` and the `'kicks'`/`'communityGift'` cases in `handleStreamlabsItem()` in `src/renderer.js`.

**Platform-colored alerts.** Follows, subs, gifted subs and Kicks tips are colored by platform: Kick alerts use Kick green (`#53FC18`) and Twitch alerts use Twitch purple (`#9146FF`). The platform comes from Streamlabs' `for` / `item.platform` field (`kick_account` / `twitch_account`); `platformClass()` in `src/renderer.js` turns that into a `plat-kick` / `plat-twitch` class, styled in `src/style.css` (`--accent-kick`, `--accent-twitch`). PayPal and nano lines keep their own colors, and an alert from any other source falls back to the old per-type colors.

**Sub alerts.** A sub reads `SUB <name> <message> (<n> mo)` — no "subscribed" wording (the SUB tag says it), the sub's own message is shown when it has one (Twitch resubs do), and the month count is on the end. Kick and Twitch subs share this code path (`case 'subscription'` in `handleStreamlabsItem()`), so both look the same; a Kick sub only shows a message if Streamlabs actually includes one in the payload's `message` field (check the `[streamlabs] subscription …` line in DevTools if you expect one and don't see it). Emotes in a Twitch resub message are shown as images (Streamlabs passes them in `emotes`, in the same `id:start-end` format as Twitch chat). Gifted subs keep their own `GIFTED SUB …` wording. All alerts show Twitch's `display_name` (`JaredStammy`) rather than the lowercase login `name` (`jaredstammy`), falling back to `name` when a payload has no display name (Kick, tips).

**First-time chatters.** A Twitch chatter's first ever message in your channel (Twitch's `first-msg=1` tag) gets a purple `FIRST` pill and a purple left border on its line, like the "First time chatter" highlight in Twitch's own chat. Kick doesn't send an equivalent marker, so this is Twitch-only.

**Chat moderation.** Deleted messages and banned/timed-out users are taken back out of the feed (chat lines only — alerts stay). Twitch uses its documented `CLEARMSG` / `CLEARCHAT` commands (a bare `/clear` of the whole chat is deliberately ignored — use the clear-chat hotkey). Kick's `MessageDeletedEvent` / `UserBannedEvent` are undocumented, so their field names (`message.id`, `user.id` / `user.username` / `user.slug`) are best guesses; the raw payloads are logged to the DevTools console (`[kick] message deleted event`, `[kick] user banned/timed-out event`) if one ever doesn't take effect. Twitch `/me` messages render as `Name text` (no colon, text in the chatter's colour, italic) instead of showing a literal `ACTION`, and Twitch emote positions are read as Unicode code points, so emotes after an emoji land correctly.

**Bits and raids.** Twitch bits (`bits` alerts) and raids (`raid` alerts) arrive through Streamlabs like the other alerts and are colored by platform (Twitch purple). Both have toggles under *Show in feed* (`showBits`, `showRaids`). **Kick raids are best-effort:** Kick has no official raid event, so the overlay accepts a Streamlabs `raid` alert from `kick_account` *and* Kick's undocumented `App\Events\StreamHostEvent` on the chat socket. The field names for both are guesses with fallbacks, and the raw payload is always logged to the DevTools console (`[kick] raid/host event`, `[streamlabs] raid …`), so if a Kick raid shows the wrong name or count, that's where to look. A raid reported by both routes within 30 seconds is only shown once.

**Twitch connection stability.** A stale-socket bug caused a permanent reconnect loop (connected → "Disconnected, retrying…" every ~4 seconds, dropping chat during each gap) once *Save* was pressed while Twitch was connected. Retired sockets now have their handlers detached before closing (`teardownTwitchSocket()`; Kick and OBS got the same guard – OBS had the identical loop when *Save* was pressed while connected), and *Save* only restarts Twitch chat / reconnects OBS if their own settings actually changed. A watchdog also catches connections that die silently: after 60 s with no data it sends a PING, and reconnects if Twitch doesn't answer within 15 s. A malformed IRC line can no longer stop the rest of its frame from displaying. Kick chat has the same protection: it answers Pusher's `pusher:ping` with `pusher:pong`, pings the server itself after the server's `activity_timeout` of silence (120 s by default), and reconnects if that goes unanswered for another 30 s.

Streamlabs also appears to redeliver the same Kick-platform alert more than once on occasion (its payloads carry `repeat`/`historical` flags, suggesting replays rather than a fresh event each time). Every alert has a stable `_id`, so `handleStreamlabsEvent()` keeps a short-lived seen-set and silently drops exact repeats — genuinely new alerts always get a new id, so this shouldn't affect anything else.

## Mic volume meter

When OBS is connected (Settings → OBS) and a mic source is set, a vertical level meter sits to the right of the chat feed, below the viewer/drops stats line — its own column, so it never overlaps or clips chat text. It fills green with the mic's live peak level and turns solid red while the mic is muted in OBS. The bar's 100% point is mapped to -21dB rather than true 0dBFS, since -21dB is about as loud as this mic realistically peaks in normal use — mapping to 0dBFS would leave most of the bar unused. Like the mic/desktop/camera status icons in the drag strip, it stays hidden until OBS actually confirms a mute state or sends a live level reading for that source — so it only appears once OBS is genuinely connected and reporting, not just because the setting is on.

## Live viewer count

Toggled on by default in Settings → "Show in feed" → "Live viewer count". It reuses the same `kick.com/api/v2/channels/<slug>` lookup already used for chat, polling every 30 seconds, and shows in a thin stats bar above the chat feed. Shows "offline" when you're not live. A status check that *fails* (network blip, Cloudflare hiccup) says nothing about whether you're live, so the previous reading is kept — live indicator, uptime and viewer count don't flip to "offline" — until 3 checks in a row have failed (~90 s). A check that succeeds and reports offline is believed immediately.

## Startup, timeouts and channel names

- Statuses main sends once at launch (Streamlabs "Connected" / "No token set", the first nanodrops poll) used to be lost when they beat the page's loading, leaving the startup "loading…" indicator stuck. The renderer now tells main when its listeners are registered (`overlay.rendererReady()`) and main replays the latest of each.
- The Kick/Twitch live-status requests have a 10 s timeout (a hung request used to freeze the live indicator and viewer count until restart), and status polls never overlap.
- The Kick/Twitch channel boxes accept pasted URLs and `@`/`#` prefixes (`https://kick.com/name/` → `name`). If Kick 404s on a name containing `_`, it's retried with `-` (Kick slugs use hyphens where usernames have underscores).

## Stream timer

The live stream timer next to the clock is coloured for the platform you're live on (Kick green, Twitch purple; while the bar flashes a mute warning it turns white for legibility). A small neutral dot separates it from the clock, and both are hidden when you're not live.

## OBS connection

If OBS rejects the WebSocket password (close code 4009) the OBS status line says **Wrong OBS WebSocket password – check Settings → OBS** and retries every 30 s instead of every 4 s; any other disconnect keeps the quick 4 s retry.

## nanodrops stats

Uses the two public endpoints Immi confirmed:
- `nanodrops.org/api/faucets/<faucetId>` — your stream's own faucet: watchers and current balance.
- `nanodrops.org/api/stats` — network-wide: total active viewers, total active balance, and the current hourly earn rate (converted to USD using the endpoint's own `usdPerXno`).

Your faucet ID (`a4552cef`) is already filled in as the default in Settings → nanodrops. Both endpoints are fetched from the main process rather than the browser page, so there's no CORS concern the way there was with the signed viewer-session API. Polls every 5 seconds; toggle the whole thing off in Settings → "Show in feed" → "nanodrops stats".

With two faucet IDs set (e.g. a Kick faucet and a Twitch faucet), watcher counts are summed, but the faucet balance shown is **not** a combined total. Each faucet response reports whether its stream is currently online; a faucet that's offline has its balance left out entirely. If only one of the two is online, that one's balance is shown on its own. If both are online, the bigger of the two balances is shown. If both are offline, no faucet balance is shown at all.

The faucet endpoint also returns any TTS messages viewers left with a drop (the same ones nanodrops reads out loud) — new ones appear in the chat feed as a "NANO" (direct tip) or "JUICED" (faucet contribution) line alongside chat and Streamlabs alerts. Only new messages show (the existing history isn't replayed on startup), same as live chat.

If the faucet's balance goes up between polls by more than what the new named messages account for, that's someone contributing to the faucet without leaving a name/note — shown as its own JUICED line without a user, e.g. "JUICED The faucet was juiced with Ӿ0.05". This is a balance-delta heuristic (there's no raw "anonymous deposit" event from the API), so it's skipped on the very first poll for a faucet (no prior balance to diff against).

An earlier version also tried correcting for drops paid out to viewers in the same ~5s poll, on the theory that a drop landing alongside a deposit would shrink the reported delta. That assumed the drops list and the balance figure are captured in sync within one API response — they aren't, so "adding the drop back" fabricated a phantom deposit tracking a fraction of the drop's amount, firing on essentially every drop. That correction has been removed; a real deposit landing in the exact same window as viewer drops can still occasionally undershoot slightly as a result, which is a smaller, rarer error than a false alert on every drop.

Separately, anything that would render as all zeros at the "Balance & JUICED alert decimal places" setting (e.g. Ӿ0.0009 at the default 2 decimal places) is skipped rather than announced as "Ӿ0.00" — no point alerting for an amount the alert itself can't display. Tightening that setting for a smaller/more precise faucet makes correspondingly smaller anonymous deposits eligible to show.

**Failure handling and baselines.** The faucet(s) and `/api/stats` are fetched independently, each with an 8 s timeout, and polls never overlap (a slow response can't arrive after a newer one and fake a balance jump). A source that fails keeps showing its last good numbers for up to 3 polls (~15 s) before its chips hide, so one dropped request doesn't blank the stats line, and a mistyped second faucet ID (or a stats hiccup) no longer takes down the first faucet — the status line in Settings names the failing source, e.g. `Connected – faucet 2: faucet endpoint HTTP 404`. The whole stats line only hides when *nothing* usable is left, and the drop ticker is only hidden then (not emptied), so it comes back with its drops on recovery. Each faucet's existing message/drop history is absorbed as a baseline the first time it's seen — even when that history is empty, so the first real message afterwards isn't swallowed — and again after a faucet ID is changed/added or nanodrops is switched off and on, so none of those replay old history as a burst of alerts or fire a false JUICED from the balance change in between. Switching nanodrops off now also hides its chips and drop ticker immediately.

If the reported amount ever looks off, `main.js` logs the underlying numbers (raw balance delta, named messages netted out) into the synthetic message's `debug` field, which the renderer prints to the DevTools console (`Ctrl+Shift+I`) as `[nanodrops] anonymous deposit` whenever one of these lines shows up.

The stats bar uses icons rather than text labels to stay compact: green head = Kick viewers, blue head = viewers watching via nanodrops, drop = your faucet balance, eye = total balance and total viewers network-wide (shown together, e.g. `👁 Ӿ2.21/4`). Hover any of them for a tooltip.

Faucet balance (both your own and the network total) and JUICED alert amounts all show 2 decimal places by default — configurable in Settings → nanodrops → "Balance & JUICED alert decimal places" (0–8), shared across all three so they stay consistent with each other. Bump it up if Nano's price ever climbs enough that amounts would otherwise round away to 0.00. The drop ticker has its own separate decimal-places setting, since it's normally showing much smaller per-drop amounts already.

## Building a standalone .exe

Once you're happy with it:
```
npm run dist
```
This uses `electron-builder` to produce a Windows installer in `dist/`. Run this on a Windows machine (or with wine configured) since it's building a native Windows target.

## Hotkeys

| Keys | Action |
|---|---|
| Ctrl+Shift+L | Toggle click-through lock (rebindable in Settings → Shortcuts) |
| F21 | Clear the chat feed (rebindable in Settings → Shortcuts — any single key or combination) |
| Ctrl+Shift+I | Toggle DevTools — **only while the overlay window has focus** (it is not a global hotkey, so it never interferes with other apps). While the overlay is locked/click-through it can't take focus; use the tray icon's **Developer Tools** entry instead. |

The rebind buttons accept any single key or combination Electron can register, including `+`, Caps Lock and the media/volume keys. A key that can't be used (dead keys, non-ASCII characters) is rejected with a message, and a key Electron refuses at registration ends capture mode with an explanation instead of leaving the button stuck.

## Window behaviour

- **One copy at a time.** Launching a second copy just brings the running overlay forward and exits (otherwise you'd get two overlays, two Streamlabs connections and shortcuts that silently fail to bind).
- **Off-screen recovery.** The saved position is checked against the monitors connected at launch; if the window's top strip wouldn't be grabbable anywhere (e.g. you unplugged the display it lived on) it opens centred on the primary display instead. The saved position isn't overwritten until you actually move the window, so a monitor that's merely asleep doesn't lose your spot. Tray → *Show / Focus*, *Open Settings*, clicking the tray icon and a second launch all pull a lost window back on-screen too.
- Position/size are saved once the window has been still for half a second (and immediately on close/quit), not on every move event.

## Project layout

```
main.js          Electron main process: window, tray, hotkeys, Streamlabs socket
preload.js       Safe bridge between main and renderer
src/index.html   Overlay + settings panel markup
src/style.css    Overlay theme (legible over arbitrary game backgrounds)
src/renderer.js  Kick chat websocket, Streamlabs event handling, feed rendering
```
