# OpenWork Mobile

Manage **sessions, workspaces and files** of [OpenWork](https://github.com/different-ai/openwork) desktop **from your phone, from anywhere** — a web app (PWA) that reconnects by itself every time you open the page, no APK required, works on both iOS and Android, at a cost of **zero**.

## About this project

OpenWork is a desktop app (Electron, open source) for running AI coding agents — but it only works at the computer. This project adds an official "back door" for the phone:

| Original requirement | How it is met |
|---|---|
| Manage existing sessions & workspaces | The bridge plugs straight into the openwork-server API already shipped inside OpenWork desktop |
| Manage files while away | File manager: browse / view / **edit + save** / upload / download |
| Stay lightweight | Bridge = 1 Node process, ~0 dependencies; web app ~42KB (15KB gzipped); no separate database |
| Remote interaction that stays connected | SSE streaming + auto-reconnect + offline queue (messages composed offline are sent when back online) |
| No APK, works on iOS | Web/PWA — open the link and it self-connects; "Add to Home Screen" behaves like a real app |
| Completely free | Cloudflare Quick Tunnel (no account needed) + OpenCode Zen free models |

**Design principle:** never rewrite what OpenWork already provides. The bridge is a thin layer: find the server → hold the token → forward a selected surface + serve the web app. When OpenWork updates, only 2 adapters need fixing (documented in [CODE_SUMMARY.md](./CODE_SUMMARY.md)).

```
Phone (PWA, any 4G/5G — NO app install needed)
   │  HTTPS via Cloudflare Quick Tunnel (bridge spawns it, $0, no account)
   ▼
openwork-bridge  (the computer, Node.js, 127.0.0.1:8788)
   │  Owner Bearer token (minted by the bridge, never exposed to the phone)
   ▼
openwork-server  (API shipped inside OpenWork desktop, dynamic port)
   ▼
opencode engine  →  sessions · models · files
```

## Features (v1)

- 📁 **Workspaces**: live list, create new workspaces (gradient FAB); while creating, **tap "Browse…" to pick a folder on the computer** (quick chips with real folder names, drill into drives → folders level by level, **"+ New folder"** creates a home for a project that isn't on disk yet) — no typing paths by hand; the folder doesn't have to exist, the server creates it
- 💬 **Sessions**: list (busy/idle in realtime), create new, full transcript view (text/tool/reasoning, markdown + code blocks), send prompts (pick a model); **agent text streams into the bubble chunk by chunk while it replies**, and losing network / locking the screen / switching Wi-Fi recovers automatically when reopened — no need to leave and come back; while the agent runs, **the Send button morphs into a red Stop button (■)** — tap again to interrupt, ChatGPT/Gemini style, and the draft you were typing is kept
- 🔐 **Permissions**: approve Allow/Deny right on the phone when the agent asks
- 🗂 **Files**: browse the folder tree, view/edit + save text files, view images **and PDFs**, upload from the phone, download files (progress %, Cancel, and a Share button for iOS "Save to Files")
- 🖥 **Screen (v1.7, mechanics learned from 9Remote; v1.9 control bar mirrors 9Remote)**: watch the computer's screen live on the phone (up to ~8-12 frames/s, JPEG compressed, never written to disk) and **control it too** — tap = click, press-and-drag = drag & drop, **type Vietnamese from the phone** (text travels over the clipboard so the desktop IME can't mangle it). The image **always accepts control input** (9Remote-style — no view-only mode; removed on the owner's call). **The page itself is a dark full-bleed viewer (9Remote-style)**: near-black canvas edge-to-edge (no card-on-white-page), the PC picture spans the full width, the keyboard + text input live on translucent blurred bars docked at the bottom, and the status badge is a small chip on the picture. Controls have **no toolbar at all**: the **keyboard panel and the clipboard text box sit always visible** right below the screen image (English keycaps, paper-plane Send — nothing to open first); a **faint corner button on the image's top-right** toggles fullscreen — tap once and the view expands (the icon flips to a collapse/shrink icon), tap again to shrink back. Stream params are fixed at the one setting that suits a phone screen (880px, JPEG 55) — the old 3-preset picker was removed as nobody ever changed it. Details below 👇
- 📎 **Files in chat (both ways)**: files the agent mentions show up as **Open/Download cards + "View in Files"** right inside the message; a **paperclip** button in the composer sends files/images from the phone for the agent to read
- 📴 **Offline queue** + auto-reconnect; installable PWA on iOS/Android home screens (192/512 + maskable icons for Android installs, apple-touch-icon for iOS)

## UI (v4 "desktop-first")

A faithful clone of the **real OpenWork desktop** UI (studied directly from the running app + its
`app-dist` CSS): **light/dark follows the system**, backgrounds `#f8fafc` / `#111113`,
**primary buttons black (light) / white (dark)** like the desktop "Add skill" button,
**per-workspace colors** (one fixed color per workspace — the color paints the **whole workspace card**: left border stripe + tinted logo tile, not just a tiny dot), the official hexagon
`openwork-mark.svg` logo (original SVG, dark variant included). The structure follows agent-control
apps (Happy, Omnara): opening the app shows **recent sessions across all workspaces**, a floating
floating 4-tab nav — **Sessions · Workspace · Screen · Settings** (tab labels and route titles are English, like the app's product vocabulary; the Settings tab uses a proper cog icon) — plus a FAB to create sessions. **Back buttons (Sessions, Workspace, Close) are always pinned to the topbar** (already sticky at the top with blur and safe-area), so they never scroll away no matter how long the content is. Follows the internal skill
`pwa-workspace-ui` (`.zcode/skills/`): 16px inputs against iOS zoom, ≥44px touch targets,
safe-area, skeleton loading, `prefers-reduced-motion`, all-SVG icons.

## Requirements

- A Windows computer running **OpenWork desktop** + **Node.js ≥ 20**
- Phone: **nothing to install** (open the link through the public tunnel — the worker's fixed URL does the rest)

## Setup (computer — once)

```bash
# 1. Bridge
cd bridge && npm install

# 2. Web app
cd ../web && npm install && npm run build

# 3. Run the bridge
cd ../bridge && npm start
```

On first run, the bridge mints a token into OpenWork and prints a **QR code holding a one-time pairing code (valid 30 minutes)**.

> ⚠️ After the **first** bridge run, restart OpenWork desktop **exactly once** so the token takes effect (OpenWork only loads `tokens.json` at startup). The bridge detects this — it's a one-time step.

## Using it on the phone (nothing to install)

When the bridge starts it **opens a Cloudflare Quick Tunnel by itself** (downloads cloudflared on first run, ~50MB) and prints to the terminal:
- A **public URL** like `https://xxx.trycloudflare.com` with a **QR holding a one-time pairing code (30 minutes)**
- Open that link on the phone (4G works anywhere) → the app **pairs itself** → receives the **device's permanent key** → *Add to Home Screen*
- From then on, tap the icon and you're in — no code needed again

Things to know about Quick Tunnel:
- **The URL changes every time the bridge/cloudflared restarts** (power loss, reboot...) — the bridge **prints a fresh QR** in the terminal; rescanning takes 10 seconds.
- No SLA (personal use: keep the bridge running and it's fine). The bridge also revives cloudflared if it dies.
- **Cloudflare rate-limits Quick Tunnel creation per IP (HTTP 429 / error 1015)** — restarting the bridge too often in a short window triggers it (each restart = a new tunnel request). The bridge backs off on its own (2 → 4 → ... max 10 minutes, also for tunnels the edge dumps right after granting) and the block lifts by itself: **don't keep restarting — that only extends the ban**. Every retry attempt is logged (`chạy cloudflared (đợt N)`) and a failed spawn (fires `error`, not `exit`) retries on its own instead of silently killing the retry chain — if the log ever goes quiet for hours while the phone says the machine is offline, that bug is fixed as of the night of 13/09 (restart the bridge once to pick the fix up).
- To disable the tunnel: run the bridge with `OPENWORK_BRIDGE_TUNNEL=0`.

**Permanent fixed URL — already available, $0:** the official web app runs on your own Cloudflare Worker (`worker/` in this repo, e.g. `https://YOUR-WORKER.workers.dev`). The bridge "reports its address" to the worker every 15 minutes (a tunnel change is reported immediately), so the phone only ever needs to remember this one URL — whatever the tunnel does, it gets found again. Device pairing QRs also point at this URL. The option below only matters if you want an extra privacy layer:

| Option | Cost | Notes |
|---|---|---|
| **The openpocket Worker (default)** | $0 | Fixed URL + multi-tenant (section below); already deployed |
| Cloudflare **Named Tunnel** + domain | ~$10/year (domain) | Fixed URL; can add Cloudflare Access (email OTP) |

**Auto-start the bridge at login (recommended):**
```bash
openpocket autostart --enable --with-openwork   # at Windows login, bridge + OpenWork open themselves
openpocket autostart --status                   # check enabled or not
openpocket autostart --disable                  # disable
```
Without `--with-openwork`, only the bridge auto-starts (you open OpenWork manually — the bridge re-probes the server every 5s, so order doesn't matter).

**Watchdog (recommended):** a scheduled task that runs `openpocket ensure` every 5 minutes — if the bridge dies silently (killed by another tool, crash, ...) it is brought back automatically, no reboot or manual start needed:
```bash
openpocket watchdog --install     # needs admin once (same elevation as autostart)
openpocket watchdog --status      # enabled or not
openpocket watchdog --uninstall   # disable
```
`ensure` is safe to run any time: if the bridge is alive it does nothing; if the port is held by an instance started outside the CLI it does NOT start a duplicate (no EADDRINUSE pile-ups). The bridge also writes its own pid file since this version, so `openpocket status/stop` see every start path (Task Scheduler task, `openpocket start`, manual).

**Launch OpenWork from the phone:** computer on + bridge running but the OpenWork app closed → the phone app shows a **"Launch OpenWork on the computer"** button (on the red banner + in Settings → Bridge status). Tap → wait ~20s → tap Re-check. Note: a fully shut down or deep-sleeping computer can't be woken — turn it on first.

### Watch & control the computer's screen ("Screen" tab)

Open the app → **Screen** tab (bottom nav) and the computer's screen appears right away, like watching a home camera:

- **Watch**: the bridge captures up to ~8-12 frames/s (80ms capture cadence) at 880px / JPEG 55 (fixed — tuned once for a phone screen, no picker), compresses and pushes straight to the phone (RAM holds exactly 1 frame — **nothing is ever written to disk**). A still screen costs nearly 0 bytes AND nearly 0 CPU: each capture is hashed raw-first, and unchanged frames skip compression entirely (only a tiny "unchanged" marker is sent — the badge counts changed frames, so it reads low on a quiet screen). Hiding the app stops the stream automatically (battery/data), reopening resumes it — there is no manual pause button.
- **Control (v2.9 — touch gestures, like real remote-desktop apps)**: the image itself is the input surface — **tap = left-click**, **swipe = scroll the PC with ONE finger** (same 24px-per-notch wheel the two-finger swipe uses — two fingers still work, the wheel buttons are gone, content follows your fingers), **hold ≈0.5s = armed** (the phone buzzes and the touch ring turns red), then **release without moving = Right-click** (the command fires on release so the held finger is still free to become a drag) or **keep dragging = drag & move** (mouse-down at the held point, moves follow, release releases), **double-tap = Double-click** (the OS aggregates two quick taps), **two-finger pinch = zoom 1x–3x** (v2.9, 9remote-style: purely client-side CSS scale on the picture — click coordinates are computed against the zoomed rect so taps stay exact, and the stream gains zero extra bandwidth; the content under your fingers stays under them while pinching). **The feed sharpens while you zoom (v3.0)**: releasing a pinch past ~1.2x recomputes the needed capture width (880 × zoom, capped at the PC's real screen width and 1600px) and quietly re-opens the stream at that size, so magnified small text stays sharp; pinch back to 1x (or tap the chip) and the cheap 880px feed returns — 9remote does this with 4 fixed quality tiers plus a 5% hysteresis valve, OpenWork computes it from the exact zoom level with a 350ms settle delay, an 80px rounding step and a 15% switch threshold so the stream never flaps. While zoomed, **one-finger swipe pans the view** instead of scrolling (clamped so the picture never detaches from the frame — drag the PC mouse again after pinching back to 1x), and a faint **"2.0×" chip at the frame's bottom-left** shows the current zoom — tap it to fit the view again; zoom auto-resets when entering/leaving fullscreen or the virtual-landscape relayout. **Local echo feedback**: a white dot follows your finger instantly and the phone vibrates — so on a laggy link you always know a tap registered and a hold armed, without waiting for the video to catch up. Gesture recognition runs entirely on the phone (latency never changes what a gesture IS — it only delays the picture). Corn­er controls (faint, on the image's top-right): **Fullscreen** always; in fullscreen two more faint icons summon the rotated **Keyboard**/**Clipboard** panels (in normal mode both panels are always visible below the image, so no toggle needed). Fullscreen is edge-to-edge and the panels live inside the fullscreen layer so nothing is unreachable. **Tapping Fullscreen forces landscape immediately, YouTube-style** — the button requests the real Fullscreen API and locks the orientation to landscape (`screen.orientation.lock`, Android Chrome rotates even with auto-rotate off; iOS Safari allows neither, so it falls back to the CSS layer and follows the device rotation — the PWA manifest is `orientation: "any"` so the installed app rotates at all). **On a portrait phone, fullscreen pre-rotates the PC picture 90° (virtual landscape)**: the image becomes a tall column hugging the left edge at the PC's exact aspect ratio with the faint function icons floating on the top-right corner — turn the phone in your hand and it reads upright, no waiting for the OS to rotate (touch coordinates are un-rotated to match). **The keyboard/text panels rotate with the PC window too**: open the keyboard in this mode and it appears as a landscape bar along the bottom of the turned view (rotated 90° in the portrait frame), like a real remote-desktop app. Outside fullscreen the view stays upright as usual; if the viewport rotates for real, the regular left-image/right-buttons landscape layout takes over. **Landscape = player mode, fullscreen or not (like YouTube auto-rotating)**: turn the phone sideways and the Screen page rearranges itself — image on the left sized to fit the shorter viewport with the faint corner icons on the top-right, and an opened keyboard/text panel floats over the lower-left corner (summoned = allowed to overlap; close it and the picture is whole again). Fullscreen uses the exact same layout, just edge-to-edge on black. Keyboard opens one panel at a time:
  - **Keyboard panel**: sticky Ctrl/Alt/Shift/Win (light up, then press a key = combo), one-tap combos **Ctrl+C / Ctrl+V / Ctrl+Z / Alt+Tab / Win+D / Win+E / Ctrl+Shift+Esc**, arrows + **Del / Space / Home / End / PgUp / PgDn**, Enter / Esc / Bksp / Tab — all in English keycaps.
  - **Clipboard panel**: text box that **pre-fills from the phone's own clipboard**, then **Send** — text travels to the computer via clipboard + paste, so Vietnamese diacritics survive even with Unikey installed (max 500 chars).
- **Limits worth remembering**: lock screen / UAC can't be captured (Windows blocks secure-desktop capture); main monitor only; apps running as Administrator can't be controlled; ~8-12 frames/s is "continuous stills", not video. With no viewer the bridge stops capturing after 90 seconds to cool down.
- Mechanics learned from **9Remote** (studied from the npm package installed on the machine): capture via `node-screenshots` + compression via `sharp`, control via a self-compiled C# daemon (SendInput), text over the clipboard — their playbook, but fully re-implemented, none of their code.

## Many computers, one web app (multi-tenant)

The shared worker URL is an "apartment building": anyone can open it, but each person only reaches **their own home machine**. The worker owner issues each friend a **username + password** pair — and `add` also prints an **invite LINK** (`…/#i=user:secret`) with the card auto-copied to the clipboard: paste it to your friend and they never type anything:

| End | How to sign in |
|---|---|
| Friend's PC | `openpocket edge join` → paste the invite link (user/pass are read from it; once, saved to config) — their bridge heartbeats into "their room" |
| Friend's phone | Tap the invite link → signs in by itself and lands straight in the app (typing fallback: open the web → the **Sign in** form is all there is → same user/pass; a permanent key is received like a normal pair — the password is never stored on the web) |

Owner-side commands (run in `worker/`, requires a logged-in `wrangler`):

```bash
openpocket add alice                       # ask for a password (Enter = auto-generates a strong random one), then print the invite link (auto-copied)
openpocket tenant add alice "Alice's PC"   # same flow — asks for a password too (Enter = auto-generates a strong random one)
openpocket tenant list                     # list rooms
openpocket tenant revoke alice             # delete a room (that machine loses its address-reporting slot)
```
Runs from any terminal — without an explicit worker URL it takes `lookupUrl` from this machine's bridge config (or env `OWM_WORKER_URL`). Same thing via `node worker/scripts/tenant.mjs …`.

**Self-serve rooms (owner not required)**: a friend who installed the GUI never needs the owner to issue anything — the desktop app's **"Create room & connect"** button calls `POST /api/tenant/create` (open, but rate-limited 5/min/IP, rooms capped at 50, `main` reserved): type your own room name + password (≥8 chars) and the room is permanent on the KV. Re-installing the machine = type the **same name + same password** again and you're back in (exact password match reconnects; a mismatch returns the same generic 401 as sign-in). The success dialog copies a `#i=user:pass` tap-to-login link to the clipboard — send it to yourself on the phone via Zalo and tap it.

The worker owner's own machine changes nothing — without joining a room it keeps the `machine:main` flow as before. A limit worth remembering: the bridge heartbeats every 15 minutes, so free KV (~1000 writes/day) fits about **~10 rooms**.

### One app, many machines — "Máy của tôi" in Settings

A phone is not limited to one machine anymore. The app keeps a **keychain** (`localStorage owm_keys`): one entry per machine, each entry = the permanent `owd_` key that THAT machine minted. **Settings opens with the "Máy của tôi" (My machines) card** listing every machine with a one-shot online check (green = online, gray = machine/tunnel down, red = key revoked on the machine — never polled in a loop, there is a manual "Kiểm tra máy" button):

- **Switch = one tap** on the machine's row: that machine's key becomes the active one and the app jumps back to Sessions — every request/SSE now carries the new room, the worker relays to the right bridge.
- **Rename = "Đổi tên"**: a local display name on THIS phone only — the machine's own `machineName` in its bridge config is untouched, so other people signing in still see the original. The keychain entry and the "connected machine" row update together; the name survives reloads.
- **Add a machine**: paste the invite link `…/#i=user:secret` (or type the room's user/pass) in the "Thêm máy" sheet — signs in, saves the key into the keychain, switches to the new machine. Re-adding the same machine replaces its key instead of duplicating the row.
- **Disconnect is the phone's decision, two levels**: **Leave** deletes the key from the app only (the machine still trusts it — sign in again to return); **Cut off** revokes the key ON the machine (`DELETE /api/devices/:id` with that machine's own key) AND deletes it from the app — that phone is dead to the machine until a fresh invite/pair. Master `owm_` tokens cannot be revoked remotely (they live in the machine's config) — the dialog says so and only removes the local entry.
- **Machines stay isolated by construction**: a key opens only the machine that issued it (the hash lives in that machine's `devices.json` alone), bridges never talk to each other, and a machine has no channel back to the phone — connections are initiated and torn down one-way, from the phone.

## Desktop helper app (OpenPocket.exe — optional, no terminal for the basics)

`desktop/` is a tiny native Windows GUI (~40KB, WinForms — compiled with the csc.exe already built into Windows, zero dependencies to install) for people who don't want a terminal. It always runs as Administrator (UAC asks once) so it can manage the same elevated bridge task the CLI creates, and every button maps 1:1 onto an existing CLI/config path — the GUI is a thin face, not a second brain:

- **My machine tab** — live status (bridge port · room + machine name · current Cloudflare tunnel URL · OpenWork desktop detection), Start/Stop/Restart bridge (via the `OpenPocketBridge` scheduled task; Stop also finds task-started, pid-file-less processes through WMI), autostart toggle (writes the same hidden VBS + elevated task as `openpocket autostart --enable`), and a **connect-a-room card**: type your own room name + password → `POST /api/tenant/create` creates the room **permanently** on the worker (an existing name + exact same password = reconnect, so reinstalling the machine needs nothing but retyping) → config saved, bridge restarted, and a `#i=user:pass` tap-to-login link is copied for the phone. An invite link `…/#i=user:secret` pasted into the card's last field auto-fills the same fields (the owner-issued path still works). There is **no worker-URL input anymore** — the GUI resolves it from the invite link / saved config / built-in default (`ResolveWorkerUrl`). That card IS the friend machine's whole setup — no terminal, no owner in the loop — plus shortcuts to the pairing QR and the logs.
- **Rooms tab** (owner machine only — needs `worker/` next to the app; disables itself with a note elsewhere) — **create a room + password** (user + display name + password ≥8 chars, empty = auto-generated strong random) → the invite link lands in the clipboard, ready to paste into Zalo; list rooms; revoke a room. Calls `worker/scripts/tenant.mjs` — same owner-only gate as the CLI (it works because YOUR wrangler is logged in on this machine; anyone else gets the Cloudflare `Authentication error`).
- **Pairing dialog** — `GET /api/pairing-code` now also returns ASCII QR generated by `qrcode-terminal` ON the bridge (one-time 30-minute code + permanent master), so the GUI just draws it in monospace and **the pairing code never leaves the machine for a third-party QR service**. Both links have copy buttons.

Build: `desktop\build.bat` → `desktop\bin\OpenPocket.exe` (`desktop/bin/` is gitignored — the exe embeds the real worker URL and binaries can't go through the pre-push washer, so rebuild locally). Unsigned exe = SmartScreen warns once ("More info → Run anyway"). Node.js 20+ must already be installed (the GUI finds node.exe, it does not install it).

**Handing the whole thing to a friend:** `openwork-bridge-friend.zip` (built locally, gitignored) = `bridge/` (src + bin + `setup-friend.bat`, no node_modules) + `web/dist/` + `OpenPocket.exe` + `HUONG-DAN.txt`. The friend installs Node.js LTS, double-clicks `setup-friend.bat` (npm install + link), then opens the exe and types their own room name + password — done, no other terminal, no owner in the loop (an invite link still works too — paste it into the same card).

## Project layout

```
bridge/          # Node.js — discovery, token bootstrap, proxy, static, QR
  src/           # index.js (entry) · proxy.js · discovery.js · bootstrap.js · auth.js · screen.js + desktop-input.cs (screen) · fslist.js …
  test/          # unit tests (npm test)
  scripts/       # e2e-live.mjs, dbg-prompt.mjs, dbg-screen.mjs (live tests against a real OpenWork)
worker/          # Cloudflare Worker "openpocket" — fixed URL + multi-tenant
  src/index.js   # /__register (room check-in) · /api/* (per-room relay) · serves the web app
  scripts/tenant.mjs # issue/delete rooms (user/pass accounts) on KV
web/             # PWA Preact + Vite → builds to web/dist served by the bridge
  src/pages/     # pairing (Sign-in-only screen, tagline under the logo; pair-code/token entry moved into Settings behind the sign-in wall) · workspaces · sessions · chat · files · screen · settings (opens with the multi-machine keychain card, pages/pcs.jsx)
  src/components/# ui.jsx (Loading/Skeleton/Empty/Banner/Sheet/Confirm) · icons.jsx (SVG set)
  .zcode/skills/ # pwa-workspace-ui: internal design skill (tokens · ui-rules · pwa-checklist)
desktop/         # OpenPocket.exe — native WinForms GUI (built by csc.exe, zero deps): self-create room (name+password) or join by invite link · create/list/revoke rooms (owner) · pairing QR · bridge start/stop/autostart
README.md        # this file
CODE_SUMMARY.md  # code map + the "symptom → where to fix" table
```

## Security (Pair Device model, learned from 9Remote)

- **One-time pairing code, lives 30 minutes**: printed in the bridge's QR/terminal — used exactly once, then dead. Even a leaked QR is only dangerous for 30 minutes.
- **Permanent device key (`owd_...`)**: after pairing, each phone gets its own key (stored on the phone; the bridge keeps only a hash). Reopening the app always goes straight in.
- **Keychain of machines changes nothing here**: the phone may hold keys to several machines, but each key still opens only the machine that minted it — carrying a bunch of keys is not a skeleton key.
- **Revoke per device**: in the app → Settings → *Paired devices*. Lost your phone? Revoke it and it loses access instantly.
- **Rooms (multi-tenant)**: each room's secret lives on the worker KV and in that person's bridge; the worker holds NO phone keys — every key is still verified by the bridge. The web stores the permanent key only, never the password. Wrong username or wrong password returns **the exact same answer** — strangers can't probe which rooms exist, let alone see each other's machines. Deleting a room (`tenant.mjs revoke`) means that machine can no longer report its address. Web sign-in is also rate-limited **at the worker itself** — 10 attempts/min/IP (counted via the Cache API, zero KV writes) — so password guessing can neither grind on it nor burn the free-tier KV read quota. **Two ways in, two different gates**: the owner CLI path (`tenant add` / `openpocket add`) is owner-only by construction — it works because YOUR wrangler is logged into YOUR Cloudflare account, anyone else hits `Authentication error`. The self-serve door (`POST /api/tenant/create`) trades that exclusivity for zero-friction friend setup and pays for it with its own guards: 5 attempts/min/IP, a hard cap of 50 rooms, `main`/`admin`-style names reserved (creating `tenant:main` would let a stranger's bridge overwrite the owner's `machine:main` address — the one real hijack risk), same username/password shape as everywhere else, and an existing name + wrong password returning the same generic 401. A stranger who finds the worker URL can therefore claim an unused room name for themselves — never touch yours.
- The `owm_...` master token is only a fallback printed in the terminal (use it at the machine, share it with no one).
- The bridge listens on `127.0.0.1` only — the outside world sees it only through the tunnel/tailnet; every request needs a valid token (deny-by-default); `/api/pair` is rate-limited against code guessing.
- OpenWork's `owt_...` owner token never reaches the browser; the proxy whitelist only allows admin paths (`bridge/src/proxy.js`).
- **Security audit 2026-09-13 (Mimosa deep scan, sealed receipt)**: every flagged item triaged. The SSRF warnings on `bridge/src/proxy.js` and `worker/src/index.js` are already contained — request paths must match a whitelist against a fixed upstream base, redirects are not followed, and `/__register` only accepts `https://*.trycloudflare.com` URLs behind a per-room secret. The `spawnSync` warnings in `bin/openpocket.js` only ever carry the machine owner's own CLI arguments (array-form, no shell). Shipped fixes: `sharp` 0.33.5 → 0.35.4 (libvips/libheif CVEs, high — takes effect at the next bridge restart) and the desktop GUI strips quotes/newlines from the tenant display name and requires an `https://` worker URL before building the `tenant.mjs` command line.
- **No default room password (2026-09-13)**: pressing Enter at any room-password prompt (CLI or GUI) auto-generates a strong random secret (`owes_` + 48 hex chars) instead of the old default `12345678` — the first password any attacker tries. The generated secret sits inside the invite link, so nothing extra to write down. Rooms created earlier with the old default should be re-keyed: revoke + add.
- **CSP on the web app (2026-09-13)**: the worker stamps `Content-Security-Policy` on every static asset (`withSecurityHeaders` in `worker/src/index.js`) — scripts strictly same-origin (no inline), styles inline-only, `img-src` allows `data:`/`blob:` for the screen stream and file previews. Verified in a real browser: the app renders, the service worker activates, and DOM-injected inline/external scripts are blocked. Loosen it there if the web ever needs a CDN script or iframe.

## Quick troubleshooting

| Symptom | Fix |
|---|---|
| Writes fail with `"Sign in to verify policy"` | Open OpenWork desktop and sign in/verify again (cloud session expired) |
| Prompt sent but no reply comes back | No model picked in chat — a model is mandatory |
| openwork-server not found | Is OpenWork desktop actually running? |
| Other | Open [CODE_SUMMARY.md](./CODE_SUMMARY.md) — the full lookup table |

## Development

```bash
cd bridge && npm test                                   # unit tests
node bridge/scripts/e2e-live.mjs <wsId> <provider> <model>   # live E2E
cd web && npm run dev                                   # dev server (proxies /api through the bridge)
cd web && npm run build && cd ../worker && npx wrangler deploy # build + deploy the "fixed URL" worker (openpocket)
cd worker && node scripts/tenant.mjs add <user> "Name"   # issue a multi-tenant room (list / revoke to manage)
```

## Publishing & privacy

`git push` from this repo is intercepted by a repo-local pre-push hook (`.githooks/pre-push`, enabled via `core.hooksPath` — a machine-local, gitignored file that is NOT part of the published repo): it builds a sanitized mirror of the history — commit identity rewritten to `ngochuyN-hash` with a noreply email, the real worker URL replaced with `https://YOUR-WORKER.workers.dev`, personal names washed — force-pushes that mirror to origin, then cancels the raw push. The local repo keeps the originals; raw refs never leave the machine. If a name/URL still survives somewhere, the hook's safety gate blocks the push instead. Don't bypass with `--no-verify`.

## Project rules

> 📌 **Every time code/structure/behavior changes, `README.md` AND `CODE_SUMMARY.md` MUST be updated in the same commit.** README = the outside (usage, features); CODE_SUMMARY = the inside (where to fix, API map). Documentation is written in English.
