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
- 🖥 **Screen (v1.7, mechanics learned from 9Remote; v1.9 control bar mirrors 9Remote)**: watch the computer's screen live on the phone (~3-4 frames/s, JPEG compressed, never written to disk) and **control it too** — tap = click, press-and-drag = drag & drop, **type Vietnamese from the phone** (text travels over the clipboard so the desktop IME can't mangle it). Input is **locked by default** (anti-accidental-click on the real PC) — the padlock on the floating toolbar unlocks it, and tapping any control implies intent and unlocks too. Controls follow **9Remote's layout in OpenWork style**: a compact icon toolbar **right below the screen image** (never covering it) — Keyboard · Mouse · Clipboard · Lock · Save photo · Fullscreen — opens one panel at a time; key labels are English keycaps; the text Send button uses a paper-plane icon. Stream params are fixed at the one setting that suits a phone screen (880px, JPEG 55) — the old 3-preset picker was removed as nobody ever changed it. Details below 👇
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
- **Cloudflare rate-limits Quick Tunnel creation per IP (HTTP 429 / error 1015)** — restarting the bridge too often in a short window triggers it (each restart = a new tunnel request). The bridge backs off on its own (2 → 4 → ... max 10 minutes, also for tunnels the edge dumps right after granting) and the block lifts by itself: **don't keep restarting — that only extends the ban**.
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

**Launch OpenWork from the phone:** computer on + bridge running but the OpenWork app closed → the phone app shows a **"Launch OpenWork on the computer"** button (on the red banner + in Settings → Bridge status). Tap → wait ~20s → tap Re-check. Note: a fully shut down or deep-sleeping computer can't be woken — turn it on first.

### Watch & control the computer's screen ("Screen" tab)

Open the app → **Screen** tab (bottom nav) and the computer's screen appears right away, like watching a home camera:

- **Watch**: the bridge captures ~3-4 frames/s at 880px / JPEG 55 (fixed — tuned once for a phone screen, no picker), compresses and pushes straight to the phone (RAM holds exactly 1 frame — **nothing is ever written to disk**). A still screen costs nearly 0 bytes. Hiding the app stops the stream automatically (battery/data), reopening resumes it — there is no manual pause button.
- **Control (v1.9 — one floating toolbar, 9Remote-style)**: icon bar sits on the screen itself — **Keyboard**, **Mouse**, **Clipboard**, **Lock**, **Save photo**, **Fullscreen** (edge-to-edge letterboxed viewing, CSS-based so it works on iOS Safari too; **Save photo** downloads the current frame as a dated `.jpg` into the phone's Downloads). The **padlock** is the old View-only switch, shrunk to where it belongs: locked = watching safely (touches on the image do nothing), unlocked = the image takes real input; any Keyboard/Mouse/Clipboard tap unlocks by itself (intent is obvious). Each control opens one panel at a time:
  - **Keyboard panel**: sticky Ctrl/Alt/Shift/Win (light up, then press a key = combo), one-tap combos **Ctrl+C / Ctrl+V / Ctrl+Z / Alt+Tab / Win+D / Win+E / Ctrl+Shift+Esc**, arrows + **Del / Space / Home / End / PgUp / PgDn**, Enter / Esc / Bksp / Tab — all in English keycaps.
  - **Mouse panel**: **Right-click**, **Double-click**, **Wheel ↑ / Wheel ↓** (they act at the last touched point; tap on the image = left-click, press-drag = drag).
  - **Clipboard panel**: text box that **pre-fills from the phone's own clipboard** for review, then **Send** — text travels to the computer via clipboard + paste, so Vietnamese diacritics survive even with Unikey installed (max 500 chars).
- **Limits worth remembering**: lock screen / UAC can't be captured (Windows blocks secure-desktop capture); main monitor only; apps running as Administrator can't be controlled; 3-4 frames/s is "continuous stills", not video. With no viewer the bridge stops capturing after 90 seconds to cool down.
- Mechanics learned from **9Remote** (studied from the npm package installed on the machine): capture via `node-screenshots` + compression via `sharp`, control via a self-compiled C# daemon (SendInput), text over the clipboard — their playbook, but fully re-implemented, none of their code.

## Many computers, one web app (multi-tenant)

The shared worker URL is an "apartment building": anyone can open it, but each person only reaches **their own home machine**. The worker owner issues each friend a **username + password** pair — and `add` also prints an **invite LINK** (`…/#i=user:secret`) with the card auto-copied to the clipboard: paste it to your friend and they never type anything:

| End | How to sign in |
|---|---|
| Friend's PC | `openpocket edge join` → paste the invite link (user/pass are read from it; once, saved to config) — their bridge heartbeats into "their room" |
| Friend's phone | Tap the invite link → signs in by itself and lands straight in the app (typing fallback: open the web → **Sign in** tab → same user/pass; a permanent key is received like a normal pair — the password is never stored on the web) |

Owner-side commands (run in `worker/`, requires a logged-in `wrangler`):

```bash
openpocket add alice                       # ask for a password, then print the invite link (auto-copied)
openpocket tenant add alice "Alice's PC"   # same, but auto-generates a strong password
openpocket tenant list                     # list rooms
openpocket tenant revoke alice             # delete a room (that machine loses its address-reporting slot)
```
Runs from any terminal — without an explicit worker URL it takes `lookupUrl` from this machine's bridge config (or env `OWM_WORKER_URL`). Same thing via `node worker/scripts/tenant.mjs …`.

The worker owner's own machine changes nothing — without joining a room it keeps the `machine:main` flow as before. A limit worth remembering: the bridge heartbeats every 15 minutes, so free KV (~1000 writes/day) fits about **~10 rooms**; each phone pairs with 1 machine (changing machines = Settings → Unpair → sign in again).

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
  src/pages/     # pairing (Sign in/Pair/Enter token) · workspaces · sessions · chat · files · screen · settings
  src/components/# ui.jsx (Loading/Skeleton/Empty/Banner/Sheet/Confirm) · icons.jsx (SVG set)
  .zcode/skills/ # pwa-workspace-ui: internal design skill (tokens · ui-rules · pwa-checklist)
README.md        # this file
CODE_SUMMARY.md  # code map + the "symptom → where to fix" table
```

## Security (Pair Device model, learned from 9Remote)

- **One-time pairing code, lives 30 minutes**: printed in the bridge's QR/terminal — used exactly once, then dead. Even a leaked QR is only dangerous for 30 minutes.
- **Permanent device key (`owd_...`)**: after pairing, each phone gets its own key (stored on the phone; the bridge keeps only a hash). Reopening the app always goes straight in.
- **Revoke per device**: in the app → Settings → *Paired devices*. Lost your phone? Revoke it and it loses access instantly.
- **Rooms (multi-tenant)**: each room's secret lives on the worker KV and in that person's bridge; the worker holds NO phone keys — every key is still verified by the bridge. The web stores the permanent key only, never the password. Wrong username or wrong password returns **the exact same answer** — strangers can't probe which rooms exist, let alone see each other's machines. Deleting a room (`tenant.mjs revoke`) means that machine can no longer report its address. **Issuing rooms is owner-only by construction**: the `tenant` command is just a local caller — it works because YOUR wrangler is logged into YOUR Cloudflare account. Anyone else running it (a friend who installed the bridge, anyone who cloned the repo) hits `Authentication error` — without your Cloudflare login the command cannot touch your KV, so nobody can self-issue rooms on your worker.
- The `owm_...` master token is only a fallback printed in the terminal (use it at the machine, share it with no one).
- The bridge listens on `127.0.0.1` only — the outside world sees it only through the tunnel/tailnet; every request needs a valid token (deny-by-default); `/api/pair` is rate-limited against code guessing.
- OpenWork's `owt_...` owner token never reaches the browser; the proxy whitelist only allows admin paths (`bridge/src/proxy.js`).

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
cd web && npm run deploy                                # build + deploy the secondary openwork-mobile-web worker (vite-plugin, backup URL)
cd worker && node scripts/tenant.mjs add <user> "Name"   # issue a multi-tenant room (list / revoke to manage)
```

## Publishing & privacy

`git push` from this repo is intercepted by a repo-local pre-push hook (`.githooks/pre-push`, enabled via `core.hooksPath` — a machine-local, gitignored file that is NOT part of the published repo): it builds a sanitized mirror of the history — commit identity rewritten to `ngochuyN-hash` with a noreply email, the real worker URL replaced with `https://YOUR-WORKER.workers.dev`, personal names washed — force-pushes that mirror to origin, then cancels the raw push. The local repo keeps the originals; raw refs never leave the machine. If a name/URL still survives somewhere, the hook's safety gate blocks the push instead. Don't bypass with `--no-verify`.

## Project rules

> 📌 **Every time code/structure/behavior changes, `README.md` AND `CODE_SUMMARY.md` MUST be updated in the same commit.** README = the outside (usage, features); CODE_SUMMARY = the inside (where to fix, API map). Documentation is written in English.
