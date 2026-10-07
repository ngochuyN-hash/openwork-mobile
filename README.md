# OpenWork Mobile

Manage **sessions, workspaces and files** of [OpenWork](https://github.com/different-ai/openwork) desktop **from your phone, from anywhere** — a web app (PWA) that reconnects by itself every time you open the page, no APK required, works on both iOS and Android, at a cost of **zero**.

The app covers **Sessions · Workspaces · Chat · Files · Settings** — nothing else. History of removed feature sets lives in git log and [CODE_SUMMARY.md](./CODE_SUMMARY.md).

## About this project

OpenWork is a desktop app (Electron, open source) for running AI coding agents — but it only works at the computer. This project adds an official "back door" for the phone:

| Original requirement | How it is met |
|---|---|
| Manage existing sessions & workspaces | The bridge plugs straight into the openwork-server API already shipped inside OpenWork desktop |
| Manage files while away | File manager: browse / view / **edit + save** / upload / download. The folder-picker seam behind it (`/api/fs/ls`, `/api/fs/mkdir`) has a deliberate error→status map (`fsStatus` in `bridge/src/routes/fs.js`, route-tested in `bridge/test/fs-routes.test.js` since 07/10 — unknown internal errors are 500, not a fake 403 "no permission") |
| Stay lightweight | Bridge = 1 Node process, **zero npm dependencies** (`qrcode-terminal` is vendored under `bridge/src/vendor/`); web bundle ~99KB raw (JS 77KB + CSS 20KB, ~31KB gzipped); no separate database |
| Remote interaction that stays connected | Event stream over fetch (auth token travels in the Authorization header, never on the URL; request headers — token and room alike — are built from the shared contract constants) with backoff reconnect + offline queue (messages composed offline are sent when back online) |
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

## Features

- 📁 **Workspaces**: live list, create new workspaces (gradient FAB); while creating, **tap "Browse…" to pick a folder on the computer** (quick chips with real folder names, drill into drives → folders level by level, **"+ New folder"** creates a home for a project that isn't on disk yet) — no typing paths by hand; the folder doesn't have to exist, the server creates it
- 💬 **Sessions**: list (busy/idle in realtime), create new, **swipe a session card left to delete it** (the card slides aside to a full-height red "Xoá" button — tap it and the conversation is deleted on the computer, right away; no confirmation dialog, the swipe itself is the deliberate step. Works the same on the Home page's recent-session list), full transcript view (text/tool/reasoning, markdown + code blocks), send prompts (pick a model); **agent text streams into the bubble while it replies** (streaming follows the engine's part protocol — `message.part.updated` snapshots keyed by part id plus `message.part.delta` character deltas, batched per animation frame like the desktop app; reasoning and every tool call render as ZCode-style one-line collapsed rows (slim chrome-less lines — icon + title + status + chevron, no card/border; tap to expand the full input/output behind a thin left rule), files the agent mentions render as slim text rows — tapping one opens it straight in the Files viewer (view + download), and tapping the model pill opens a searchable bottom-sheet picker grouped by provider with a Recents section, and losing network / locking the phone / switching Wi-Fi recovers automatically when reopened — no need to leave and come back; scrolling around mid-reply never yanks the view away (a mid-run transcript refetch keeps the still-streaming message instead of dropping it until the machine persists it); while the agent runs, **the Send button morphs into a red Stop button (■)** — tap again to interrupt, ChatGPT/Gemini style, and the draft you were typing is kept. **Permission prompts actually work**: the engine expects `{reply: "once" | "always" | "reject"}`, so tapping Allow really releases the agent instead of leaving it stuck at the approval step. Offline messages queued in one session are never sent into another
- 🔐 **Permissions**: approve Allow/Deny right on the phone when the agent asks
- ✋ **When the agent asks you something** — the engine can pause a run to put a real question to you (`GET /question`). The phone now shows it as a card: tap the options (multi-select when the question allows it), type your own answer where offered, hit **Trả lời**, or **Bỏ qua** to let the agent continue on its own assumption. Before this, a question was invisible and the run simply sat there
- ↩️ **Undo, branch, edit — on a single conversation** (the parity work with the desktop app): **tap any message** to get an action sheet — **Chép nội dung · Sửa & gửi lại · Tạo nhánh mới · Hoàn tác từ tin này · Xoá tin nhắn**. *Undo* hides everything from that message on and offers "N tin nhắn phía sau đang ẩn · **Hiện lại**"; *Edit & resend* replaces the old turn instead of stacking a second copy on top of it; *Branch* copies the conversation up to that message into a **new session** and takes you there. A one-line "x/7 · <task in progress>" strip shows the agent's own todo list
- 🤖 **Pick the agent, run a skill**: an agent pill sits next to the model picker (the machine's real agents — `openwork`, `build`, `explore`, `plan`, …) and rides along with the prompt; typing `/` in the composer offers the workspace's **commands and skills** to run
- 🗂 **Files**: browse the folder tree, view/edit + save text files, view images **and PDFs**, upload from the phone (up to the engine's real 5 MB cap), download files (progress %, Cancel, and a Share button for iOS "Save to Files"); text files too big to open on a phone are refused with a clear reason instead of freezing the tab. Office files (`.docx`/`.xlsx`/`.pptx`), archives and binaries **download straight to the phone** instead of opening a blank page — open them in the real app
- 📎 **Files in chat (both ways)**: files the agent mentions show up as **Open/Download cards + "View in Files"** right inside the message; a **paperclip** button in the composer sends files/images from the phone for the agent to read
- 🖥️ **"Which OpenWork is on the computer?"** — Settings → **OpenWork trên máy tính** shows whether the app is **running right now** or merely installed, the resolved `OpenWork.exe` path, **where the bridge found it** (env / config / well-known folder) and the **installed version**, read from the app's own `resources/app.asar` (pure Node, no PowerShell spawn, cached per asar mtime so the 15s status poll doesn't re-read + re-parse the ~3.5 MB header). When nothing is found it offers **the fix, not just the verdict**: the well-known candidate paths as one-tap buttons + a field to type any other path (Enter submits, quotes from a "Copy as path" are stripped for you) → saved by `POST /api/openwork/path`, which only stores the path (it never executes it) and accepts a file named exactly `OpenWork.exe`, because that stored value is what remote-wake later launches. The same chooser stays reachable afterwards via **"Đổi đường dẫn"** — reinstalling OpenWork is an ordinary event, not a dead end
- 🧩 **Session extras from the desktop app** (parity round): per-session **cost** display, **rename**, **/compact** (summarize), **steer** — send messages while the agent is still running — **effort/variant** options in the model picker, **search across session names + content**, and a **share link**. (Pin / archive / groups shipped in the same round and were later **removed on purpose**: a single-user app doesn't need session organizers, so a session row is just title, time and status.)
- 🔗 **Pair another device straight from the phone** — Settings → *Thiết bị đã ghép* → "Ghép thiết bị khác" shows the bridge's live **one-time pairing code** (`XXXX-XXXX` with a mm:ss countdown; one use, 30-minute expiry) plus a copyable invite link for the new device's login screen — no terminal visit needed. The master-token QR deliberately stays terminal/GUI-only. The same page carries the desktop's maintenance actions: **rename the machine** (the next paired device sees it), **restart the tunnel** (replaces cloudflared, keeps the bridge) and **reload the engine** (`POST /workspace/:id/engine/reload`)
- ⬇️ **Always lands on the newest message** — open a conversation and you're at the live end of it, never at the top of a long transcript (it used to open on the *oldest* message and make you scroll). While the agent is replying the view follows the text down, even when a single block is taller than a screen. Scroll up to read history and a **"Tin mới nhất" / "N tin mới" pill** appears just above the composer — one tap returns you to the bottom; the count only ticks on whole new messages, so it stays still mid-stream.
- 📊 **Real markdown in chat** — assistant replies render the way the desktop app does: **markdown tables** (numeric columns right-aligned, wide tables scroll sideways instead of squashing on a phone), bold/italic, headings, links, quotes, lists and code blocks. Raw HTML inside a reply is escaped and `javascript:` links are neutralised.
- 📎 **The composer stays at the bottom of the screen** — on a short conversation the input box used to stop right under the last message, halfway down the phone, leaving a large empty area beneath it. It now sits flush at the bottom whatever the transcript length; long conversations still pin it while you scroll.
- 📴 **Offline queue** + auto-reconnect; installable PWA on iOS/Android home screens (192/512 + maskable icons for Android installs, apple-touch-icon for iOS)

## UI ("desktop-first")

A faithful clone of the **real OpenWork desktop** UI (studied directly from the running app + its
`app-dist` CSS): **light/dark follows the system**, backgrounds `#f8fafc` / `#111113`,
**primary buttons black (light) / white (dark)** like the desktop "Add skill" button,
**per-workspace colors** (one fixed color per workspace — the color paints the **whole workspace card**: left border stripe + tinted logo tile, not just a tiny dot), the official hexagon
`openwork-mark.svg` logo (original SVG, dark variant included). The structure follows agent-control
apps (Happy, Omnara): opening the app shows **recent sessions across all workspaces**, a floating
3-tab nav — **Sessions · Workspace · Settings** (tab labels and route titles are English, like the
app's product vocabulary; the Settings tab uses a proper cog icon) — plus a FAB to create sessions.
**Back buttons (Sessions, Workspace, Close) are always pinned to the topbar** (already sticky at the
top with blur and safe-area), so they never scroll away no matter how long the content is. The list
is deliberately **dense** so many sessions fit one screen: a session row is two lines of text
(title + time, status dot on the right), the only button above the list is **Search in workspace**,
and the nav bar is 49px. Follows
the internal skill `pwa-workspace-ui` (`.zcode/skills/`): 16px inputs against iOS zoom, ≥44px touch
targets for primary actions, safe-area, skeleton loading, `prefers-reduced-motion`, all-SVG icons.
(The pin / assign / archive icon buttons that used to sit on every row — 32px, an owner-approved
exception to the 44px rule — are gone with the feature they served.)

**Motion**: `:root` owns the timing tokens — `--dur-tap` 120ms, `--dur-ui` 200ms,
`--dur-move` 300ms, `--dur-spin` 800ms, `--dur-shimmer` 1200ms, `--dur-pulse` 1600ms and
`--ease cubic-bezier(.2,.7,.3,1)`. Every transition in the stylesheet uses them; a literal
`0.2s` in `styles.css` is a leftover. Buttons animate `transform/filter/opacity` only (never
`width/height/margin`, which thrash layout) and press to `scale(0.97)` on `:active`. Before
this the file carried seven hardcoded durations in seven places and `button.btn` had **no
transition at all** — hover/active snapped instantly, which is what made the UI feel cold.

**Design skills** live in `.zcode/skills/` (gitignored, local only) and each answers a
different question. `pwa-workspace-ui` = what this project *requires*. `ui-dep` = what to
*do* to make a page look and feel good (positive playbook: style layering, a do-this table
for ten surfaces, motion values, microcopy). `ui-ux-pro-max` = the standard UX rule for one
specific situation, searchable offline (`search.py "<query>" --domain ux`, 119 rules) — read
`ui-ux-pro-max/OPENWORK.md` first, because its generated palette and Google Fonts contradict
this project's hard rules.

## Requirements

- A Windows computer running **OpenWork desktop** + **Node.js ≥ 20** (node.exe runs the bridge; the bridge's own packages ship inside the Setup installer)
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
- **Tunnel resilience hardening (evening 13/09, after a full day of 429 churn)**: cloudflared now runs **http2 over IPv4 instead of QUIC/UDP** (the UDP path kept dying on flaky networks — each death minted a new tunnel request that fed the limit); the backoff countdown **survives bridge restarts** (`tunnel-state.json` in the bridge data dir — restarting no longer resets the wait, it resumes it); while Cloudflare is blocking, the bridge keeps telling the worker "machine alive, tunnel waiting" so the phone shows a clear message with the retry ETA instead of a raw error page or a fake "offline"; `openpocket status` and the OpenPocket GUI show the same countdown with a "don't restart" warning. **Manual override (night 13/09)**: the OpenPocket GUI gets a **"Restart tunnel"** button (also `POST /api/tunnel/restart`) — it cancels the countdown and asks Cloudflare for a fresh tunnel immediately, WITHOUT restarting the bridge (only the cloudflared process is replaced; the new URL re-registers itself). Made for the hit-or-miss case where the persisted countdown no longer matches reality (e.g. the IP changed after a router reboot); if Cloudflare still counts the IP as limited, it 429s again and the normal backoff resumes by itself. **GUI status fix (05/10)**: a task-run bridge never prints the tunnel URL to its log (`printPairing` is TTY-gated so tokens/QRs stay out of log files), so the OpenPocket GUI — which scanned the log tail for it — stayed on "Connecting..."; it now reads the live URL from `tunnel-state.json` (the bridge's own state file, already used for the backoff countdown) and only falls back to the log. **GUI status over the bridge API (07/10)**: the GUI now asks `GET /api/state` — tunnel phase/URL/backoff come straight from the bridge — with `tunnel-state.json` demoted to a read fallback for when the bridge can't answer; the log-scraping fallback (`UrlFromLog`, a third copy of the trycloudflare regex) is gone, and the fallback file is JSON-parsed properly instead of `Regex.IsMatch`.
- To disable the tunnel: run the bridge with `OPENWORK_BRIDGE_TUNNEL=0`.

**Permanent fixed URL — already available, $0:** the official web app runs on your own Cloudflare Worker (`worker/` in this repo, e.g. `https://YOUR-WORKER.workers.dev`). The bridge "reports its address" to the worker every 15 minutes (a tunnel change is reported immediately), so the phone only ever needs to remember this one URL — whatever the tunnel does, it gets found again. Device pairing QRs also point at this URL. **A pairing code typed by hand (no QR) routes too** (fixed 13/09): a typed code carries no room id, so the worker asks every live machine and the one that recognizes the code answers — the old silent fallback `machine:main` no longer exists. The option below only matters if you want an extra privacy layer:

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
`ensure` is safe to run any time: if the bridge is alive it does nothing; if the port is held by an instance started outside the CLI it does NOT start a duplicate (no EADDRINUSE pile-ups). The bridge also writes its own pid file since this version, so `openpocket status/stop` see every start path (Task Scheduler task, `openpocket start`, manual). **Since 07/10 the Task-Scheduler surface has ONE owner** — the task XML template (battery-proof flags), the no-BOM VBS wrappers, the task names and the healthy/needsRepair assessment live only in `bridge/src/autostart.js`, unit-tested in `bridge/test/task-xml.test.js`; the OpenPocket GUI no longer keeps a hand-synced C# copy — it shells out to `openpocket tasks --json`, `autostart --enable|--disable|--run`, `watchdog --install|--uninstall` and reads JSON. **Since 07/10 the CLI builds pairing URLs through the shared contract like every other producer**: `openpocket code` used to hand-assemble `#p=`/`#t=`/`&m=` links outside `shared/contract.js` — the file that calls itself the single owner of that shape — and re-parsed `tunnel-state.json` by hand in `status`; both now go through `buildPairingUrl` / `loadTunnelState` (`bridge/src/tunnel.js`), verified byte-identical against the old hand-built forms.

**Logs don't pile up (2026-09-13):** the bridge keeps no log history on the machine — `bridge.log` / `bridge-task.log` / `watchdog.log` in `%APPDATA%\openwork-bridge\` are truncated at boot if they hold a previous day's lines, wiped again at local midnight while the bridge runs, and wiped clean when you stop things: `openpocket stop` and the OpenPocket GUI **Stop** button delete the log files outright (the bridge is dead by then), while the GUI tray **"Thoát hẳn"** truncates them (the bridge keeps running headless and still holds its append handles). Crash-time output survives so a failure stays debuggable — `openpocket logs` right after a stop correctly says "Chưa có log."

**Launch OpenWork from the phone:** computer on + bridge running but the OpenWork app closed → the phone app shows a **"Launch OpenWork on the computer"** button (on the red banner + in Settings → Bridge status). Tap → wait ~20s → tap Re-check. Note: a fully shut down or deep-sleeping computer can't be woken — turn it on first.

**Which OpenWork is on the computer (2026-10-03):** Settings → **OpenWork trên máy tính** shows whether the app is **running** or only installed, the resolved `OpenWork.exe` path, where the bridge found it (env / config / well-known folder) and its **version**, read from the installed app's own `resources/app.asar` → `package.json` (`bridge/src/openwork-version.js` — pure Node, no PowerShell spawn, version cached per asar mtime so a 15s status poll doesn't re-read + re-parse the ~3.5 MB header each time). "Running" is a real process check (`kill(pid, 0)`), not just the presence of the registry entry, which survives the app closing. When nothing is found, the same card offers the well-known candidate paths as one-tap suggestions plus a field to type any other path (Enter submits; a path copied from PowerShell arrives wrapped in quotes, and those are stripped for you) → **`POST /api/openwork/path`** saves it. The route only stores, it never executes: validated as non-empty, quotes stripped, ≤400 chars, existing, a file, and named exactly `OpenWork.exe` — because the saved value is precisely what `/api/openwork/wake` and the boot auto-launch later `spawn()`. Rejections come back with a Vietnamese `message` the app shows verbatim. The card is a two-way door, not a verdict: **"Đổi đường dẫn"** re-opens the same chooser after a reinstall, **"Quét lại máy tính"** forces an immediate re-check instead of waiting out the poll, and a success message points at the next step instead of just saying "done".

**The fix is where the error appears (2026-10-03):** the red "OpenWork isn't running" banner is rendered on **every** screen including chat, and its wake button used to receive the bridge's `candidates` on failure and **throw them away** — so the one screen where people hit the problem had no way out, while the complete chooser sat two taps away in Settings where nobody looks. Both now render the same chooser (`web/src/components/openwork-fix.jsx`), and it drops in **inline under the banner** the moment the bridge suggests paths and no exe is found. Candidate paths arrive from two sources (the `/api/state` poll and failed wakes) and are merged through `web/src/lib/openwork-fix.js` — pure, unit-tested logic — so a second failed wake can no longer erase what the first one found, and only real path strings ever reach a button. Saving goes through one contract: the caller must **re-throw** on failure (including HTTP 200 with `found: false`), or the component wipes the path the user just typed. `bridge/test/openwork-routes.test.js` spawns a real bridge and covers both routes over HTTP — they had no wire-level test at all, including the guard that refuses a `calc.exe` submitted from the phone.

## Many computers, one web app (multi-tenant) — DORMANT since the one-PC simplification

> **Simplification (13/09, owner call — "chỉ cần quản lý 1 PC"):** the product is now ONE machine per person. The web has **no account login anymore** — the entry is a single **8-char pairing code / QR** straight from the desktop app (9remote-style) or the **pasted permanent master key** (second row — master link `#t=…&m=…` logs straight in, a bare `owm_/owd_` key carries no room and the worker REFUSES roomless entries (400 `tenant_required`) — the pairing row's **Phòng box** takes the room name instead); the desktop exe **provisions its machine identity silently** on first run (random `pc-xxxxxxxx` room + 48-hex secret via `POST /api/tenant/create` — the user never sees a form) and ships with the bridge's `node_modules` **inside the Setup installer** (no npm install on the friend machine). Everything below still works at the API level but **no UI points at it**: no sign-in form, no invite links in the UI, no room manager. Kept dormant because it costs nothing and the routes are already built and tested.

The shared worker URL is an "apartment building": anyone can open it, but each person only reaches **their own home machine**. Room admin (rare; requires a logged-in `wrangler`):

```bash
node worker/scripts/tenant.mjs list                 # list rooms
node worker/scripts/tenant.mjs revoke alice         # delete a room (that machine loses its address-reporting slot)
```

(The old `openpocket add` / `openpocket tenant add` / `openpocket edge join` CLI commands were REMOVED 13/09 with the one-PC simplification — rooms are self-serve now and the desktop exe provisions its machine silently. `worker/scripts/tenant.mjs add` still works for the owner who wants to pre-create a room by hand; the `#i=` invite link it prints is no longer consumed by any UI — the web's sign-in form is gone.)

**Self-serve rooms — but only from the owner's exe build**: the desktop app's silent provisioning calls `POST /api/tenant/create` with an **invite key baked into the exe at build time** (`desktop/invite.key`, gitignored → `src/InviteKey.cs` generated by the build scripts). The worker compares it against the `ROOM_CREATE_KEY` dashboard secret: match → room created (rate-limited 5/min/IP, rooms capped at 50, `main` reserved); missing/wrong key, or the secret not set yet → 403 `invite_required`. Someone who only knows the worker URL — or who compiles the exe from the public repo, which ships without `invite.key` — cannot open rooms. Re-installing the machine = provisioning runs again with the same name + password logic and you're back in (exact password match reconnects; a mismatch returns the same generic 401 as sign-in).

The worker owner's own machine changes nothing — without joining a room it keeps the `machine:main` flow as before. A limit worth remembering: the bridge heartbeats every 15 minutes, so free KV (~1000 writes/day) fits about **~10 rooms**.

## Desktop helper app (OpenPocket.exe — the installer, no terminal, no forms)

`desktop/` is a tiny native Windows GUI (~60KB, WinForms — compiled with the csc.exe already built into Windows, zero dependencies to install). **One PC, one page, 9remote-style** — it always runs as Administrator (UAC asks once) so it can manage the same elevated bridge task, and first run is fully automatic:

- **No runtime install**: the bridge is **zero-dependency** — `qrcode-terminal` is vendored as plain source in `bridge/src/vendor/` (Apache-2.0/MIT headers kept), so there is no `node_modules` to ship and the GUI never runs npm. "Bật Bridge" only verifies the pieces (`bridge/src/index.js`, `node.exe`) via `EnsureBridgeDepsPresent()` and shows one precise message per missing piece.
- **Self-provisioning identity**: first run silently creates the machine's identity (random `pc-xxxxxxxx` room + random 48-hex secret through `POST /api/tenant/create`) and saves it into `%APPDATA%\openwork-bridge\config.json` plus the built-in worker URL as `lookupUrl` — the user types nothing anywhere. A machine that already has a config (the owner's) is left untouched; a provisioning failure is reported in red on the status card with a retry button (never swallowed silently). **Since 06/10 the bridge is the single writer of `config.json`**: the GUI's saves go through `POST /api/config/identity` on localhost (master-token only — identity fields only, never `mobileToken`/`port`), and fall back to a direct file write only when the bridge isn't running. **Since 07/10 both identity routes (`/api/machine/name` and `/api/config/identity`) are thin adapters over one bridge module** (`bridge/src/identity.js` — whitelist + sanitize + save + log in one place), and the closed 4-key whitelist has ONE source file: `shared/identity-keys.txt`, read by the bridge at runtime and compiled into the exe as generated `IdentityKeys.cs` (`desktop/build.bat`, same pattern as `InviteKey.cs`) so the GUI can never silently drop a key the bridge accepts.
- **One page**: live status (bridge port · machine identity provisioning · current Cloudflare tunnel URL with an inline ↻ restart icon · OpenWork desktop detection), Start/Stop/Restart bridge, autostart toggle, the **QR pairing dialog — the one feature**: `GET /api/pairing-code` returns the ASCII QR + 8-char code (30-minute one-time + permanent master, generated by the vendored `qrcode-terminal` ON the bridge — the code never leaves the machine for a third-party QR service). **Since 07/10 the GUI decodes that ASCII back into the QR matrix and draws a black-on-white bitmap** (`QrAsciiRenderer` in `PairingQrDialog.cs`) — both codes render at the same ~245px size regardless of payload length (integer-pixel modules, 4-module white quiet zone per spec, scaled by the monitor's DPI), and in standard scan polarity: the terminal-oriented ASCII paints dark modules as spaces (an inverted QR), so the old font-based rendering relied on the scanner accepting inverted codes. Phone scans → in. Plus a logs shortcut. **Closing the window (X) hides the app to the system tray** — double-click the tray icon to bring it back, 'Thoát hẳn' is the only real exit. All UI callbacks route through `SafeInvoke` (a disposed-window race during a background callback can no longer crash the process), `schtasks` calls carry 10s timeouts, and the WMI stop fallback matches the bridge's full entry-script path so it can never kill an unrelated node process. The app icon is OpenWork's real isometric mark with colors inverted — white strokes on a black tile. **Since 07/10 launching the exe self-heals the autostart feature**: tasks are created from XML with battery-proof settings (`DisallowStartIfOnBatteries=false`, `StartWhenAvailable=true` — schtasks' defaults silently skip tasks while on battery, caught live on 07/10), the task must carry a real LogonTrigger (not merely exist) or it is recreated, and the `OpenPocketBridgeWatchdog` task (every 5 min → `openpocket ensure`) is re-created whenever autostart is on — a bridge killed by a reboot, a missed logon on battery, or a crash recovers within 5 minutes.
- Removed on the owner's call: the room join card, the Rooms tab (create/list/revoke via tenant.mjs), the invite-link paste and the worker-URL input — all login-related surface is gone.
- **Source layout (since 06/10)**: `OpenPocket.cs` (main form: layout + orchestration only, ~1k lines) plus one module per concern next to it — `Ui.cs` (self-drawn buttons/primitives), `BridgeConfig.cs` (config read), `BridgeProcess.cs` (node + start/stop), `TunnelState.cs` (tunnel status), `AutostartTask.cs` (schtasks autostart + watchdog, launch-time self-heal), `BridgeHttp.cs` (localhost API calls), `Provisioning.cs` (identity helpers), `PairingQrDialog.cs` (the QR popup); `build.bat` compiles them all together.

Build: `desktop\build.bat` → `desktop\bin\OpenPocket.exe` (`desktop/bin/` is gitignored — the exe embeds the real worker URL and binaries can't go through the pre-push washer, so rebuild locally). Unsigned exe = SmartScreen warns once ("More info → Run anyway"). Node.js 20+ must already be installed (the GUI finds node.exe and runs the bridge from next to it).

**Handing the whole thing to a friend:** the installer is **`OpenPocket-Setup.exe`** — ONE file, built by `node desktop/build-setup.js`, gitignored like all binaries. It is a small C# WinForms app (compiled with the same built-in csc) with the whole package zip EMBEDDED as a resource — including the vendored `bridge/node_modules`. The friend double-clicks it: a Node.js check shows a **non-blocking Yes/No warning** (node.exe is still needed to RUN the bridge — the install itself proceeds either way; a missing install opens the nodejs.org page on request), a progress window, extraction into `%LOCALAPPDATA%\OpenPocket` (reinstall = in-place upgrade — the `%APPDATA%` config and identity survive), Start-Menu + Desktop shortcuts, and the app opens itself (UAC: Yes once — asked by the app; the setup runs non-elevated). The app does the rest (identity provisioning, the QR). The builder asserts `web/dist` is fresh before staging (a stale bundle aborts the build instead of shipping silently) and `--stage-only` runs the stage step alone for verification. `OPENPOCKET_TEST_DIR` env redirects the install for unattended testing. The installer is the ONLY artifact — rebuild the exe after every change.

## Bridge self-update over-the-air — REMOVED

The OTA self-update system was removed: the updater module, the rollback watchdog, the release publisher, the worker's KV release routes, and the `bridge/VERSION` file (`bridge/package.json` is the single version source now). **The only distribution channel is a fresh `OpenPocket-Setup.exe`** (or replacing `bridge/src` by hand and restarting the bridge). History: git log (commits `2a202a3`, `3df494d`) + [CODE_SUMMARY.md](./CODE_SUMMARY.md).

## Project layout

```
bridge/          # Node.js — discovery, token bootstrap, proxy, static, QR
  src/           # index.js (entry: boot → discovery → listen) · app.js (route table + auth gate) · routes/ (pairing · status · config · openwork · fs · proxy) · router.js · rate-limit.js · http-util.js · proxy.js · discovery.js · bootstrap.js · auth.js · pairing.js · fslist.js · tunnel.js · lookup.js · openwork-version.js · logwipe.js …
  test/          # unit tests — 22 files, 117 tests (npm test)
  scripts/       # e2e-live.mjs, dbg-prompt.mjs (live tests against a real OpenWork)
worker/          # Cloudflare Worker "openpocket" — fixed URL + multi-tenant
  src/index.js   # /__register (room check-in) · /api/* (per-room relay) · serves the web app
  scripts/tenant.mjs # issue/delete rooms (user/pass accounts) on KV
web/             # PWA Preact + Vite → builds to web/dist served by the bridge
  src/pages/     # pairing (two ways in: 8-char code / permanent key + room box) · workspaces · sessions · chat · files · settings (bridge status + paired devices)
  src/components/# ui.jsx (Loading/Skeleton/Empty/Banner/Confirm/SwipeRow) · icons.jsx (SVG set) · model-picker.jsx · chat-message-parts.jsx · chat-sheets.jsx
  src/lib/       # pure, unit-tested logic — blob-cache (object-URL LRU for file previews) · markdown · sse · chat-stream · chat-events · chat-file-refs · chat-scroll · file-viewer · session-* · route · net · settings-state
  test/          # real unit suites — 27 files, 443 tests (api contract + blob cache · markdown · chat stream · chat events + file refs · session helpers · file viewer · contract fixture)
  .zcode/skills/ # pwa-workspace-ui: internal design skill (tokens · ui-rules · pwa-checklist)
desktop/         # OpenPocket.exe — native WinForms GUI (built by csc.exe, zero deps): ONE page — status · bridge start/stop/autostart · self-provisioned identity · QR pairing (bridge is zero-dependency since 06/10 — qrcode-terminal vendored in bridge/src/vendor, no npm install ever). OpenPocket.cs holds only the main form — one module per concern sits beside it (Ui · BridgeConfig · BridgeProcess · TunnelState · AutostartTask · BridgeHttp · Provisioning · PairingQrDialog). Config saves go through the bridge API (single writer). No login/rooms (removed 13/09)
shared/          # API contract, ONE source of truth for all runtimes: link shapes (#p/#t/&m), x-owm-* headers, cross-layer error codes, token prefixes + buildPairingUrl() — imported by bridge, web AND worker; drift-guarded by web/test/contract-fixture.test.js
README.md        # this file
CODE_SUMMARY.md  # code map + the "symptom → where to fix" table
```

## Security (Pair Device model, learned from 9Remote)

- **One-time pairing code, lives 30 minutes**: printed in the bridge's QR/terminal — used exactly once, then dead. Even a leaked QR is only dangerous for 30 minutes.
- **Permanent device key (`owd_...`)**: after pairing, each phone gets its own key (stored on the phone; the bridge keeps only a hash). Reopening the app always goes straight in.
- **Revoke per device**: in the app → Settings → *Paired devices*. Lost your phone? Revoke it and it loses access instantly.
- **Rooms (multi-tenant)**: each room's secret lives on the worker KV and in that person's bridge; the worker holds NO phone keys — every key is still verified by the bridge. The web stores the permanent key only, never the password. Wrong username or wrong password returns **the exact same answer** — strangers can't probe which rooms exist, let alone see each other's machines. Deleting a room (`tenant.mjs revoke`) means that machine can no longer report its address. Sign-in is rate-limited **at the worker itself** (via the Cache API, zero KV writes) — so password guessing can neither grind on it nor burn the free-tier KV read quota. The self-serve door (`POST /api/tenant/create`) has its own guards: 5 attempts/min/IP, a hard cap of 50 rooms, `main`/`admin`-style names reserved (creating `tenant:main` would let a stranger's bridge overwrite the owner's `machine:main` address — the one real hijack risk), and an existing name + wrong password returning the same generic 401. A stranger who finds the worker URL can therefore claim an unused room name for themselves — never touch yours.
- The `owm_...` master token is only a fallback printed in the terminal (use it at the machine, share it with no one).
- The bridge listens on `127.0.0.1` only — the outside world sees it only through the tunnel; every request needs a valid token (deny-by-default); `/api/pair` is rate-limited against code guessing.
- OpenWork's `owt_...` owner token never reaches the browser; the proxy whitelist only allows admin paths (`bridge/src/proxy.js`).
- **Security audit 2026-09-13 (Mimosa deep scan, sealed receipt)**: every flagged item triaged. The SSRF warnings on `bridge/src/proxy.js` and `worker/src/index.js` are already contained — request paths must match a whitelist against a fixed upstream base, redirects are not followed, and `/__register` only accepts `https://*.trycloudflare.com` URLs behind a per-room secret. The `spawnSync` warnings in `bin/openpocket.js` only ever carry the machine owner's own CLI arguments (array-form, no shell). Shipped fixes: the desktop GUI strips quotes/newlines from the tenant display name and requires an `https://` worker URL before building a command line; the `sharp` exposure flagged by the scan disappeared entirely when that dependency (and the other native packages) were removed from the bridge — and since 2026-10-06 the bridge carries **no npm dependencies at all**: `qrcode-terminal` is vendored under `bridge/src/vendor/` (output verified byte-identical against the npm package before the dependency was dropped).
- **No default room password (2026-09-13)**: pressing Enter at any room-password prompt (CLI or GUI, while those surfaces existed) auto-generates a strong random secret (`owes_` + 48 hex chars) instead of the old default `12345678` — the first password any attacker tries. Rooms created earlier with the old default should be re-keyed: revoke + add.
- **CSP on the web app**: `withSecurityHeaders` in `worker/src/index.js` covers the responses the Worker itself writes, `bridge/src/static.js` covers the tunnel the bridge serves itself, and `web/public/_headers` covers Cloudflare asset-first delivery. Because `worker/wrangler.jsonc` sets `run_worker_first: ["/api/*", "/__register"]`, Cloudflare serves every static request straight from the asset layer — so at the Worker door the authoritative header source is `web/dist/_headers` (regenerated on every `vite build`), not the Worker script. Keep all three copies synchronized — same-origin scripts, same-origin/inline styles, and `data:`/`blob:` images for file previews — plus `x-content-type-options: nosniff` and `referrer-policy: no-referrer`. `bridge/test/static-headers.test.js` diffs the bridge copy against the other two directive by directive. The current local build includes `_headers`; this maintenance pass does not verify deployed headers.
- **No credential ever rides a URL (2026-10-04)**. Every request authenticates with the `Authorization` header. Two tags cannot set a header — `<img>` and `<iframe>` — so they used to carry `?_t=<token>` in their `src`, which put the key in browser history, in the `Referer` of every later request, and in the access logs of the worker, cloudflared and bridge. Now `blobUrlFor()` (`web/src/api.js`) fetches by header and hands the tag a `blob:` object URL, cached by `web/src/lib/blob-cache.js` (LRU by bytes, so one big file can't quietly eat the phone's RAM). File links in chat markdown point at the app's own Files page instead of a raw URL. The room id still rides `?_m=` — a routing label, not a secret. `grep -n '_t=' web/src` should return comments only; a new surface that needs a URL the browser loads by itself should use `blobUrlFor`, never a query token. The bridge's `?_t=` acceptance was **removed on 2026-10-05** (`bridge/src/auth.js`) — the `Authorization` header is the only way in, and an installed PWA running an older cached bundle reloads once (service worker v55) to pick up a bundle that never puts a key on a URL.

## Security hardening pass (2026-10-04) — deployed 2026-10-05

A three-layer audit (worker → bridge → web, 04/10) found **no critical hole** — no XSS, no SSRF, no arbitrary file read — but it did find four things worth closing before a stranger can lean on them. All four are patched and **live since 05/10**: worker version `92321f13` serves CSP + `nosniff` + `no-referrer` (verified with curl on the worker URL), and the bridge was restarted onto the patched code — which also minted a new tunnel URL, so phones re-linked via a fresh QR.

- **A paired phone no longer gets the master token.** `GET /api/pairing-code` used to answer *every* caller with `masterUrl` + `masterQr`, both carrying the permanent `owm_…` key inside `…/#t=`. The auth gate lets a revocable device key (`owd_…`) through that route, so a single call before a phone was revoked was enough to hold a token that revoking it can never take back — quietly breaking the project's "lost my phone → revoke it → clean" promise. Now the master fields are built **only when the caller is the master**; a device key still receives the pairing data it is entitled to (`code`, `codeFormatted`, `secondsLeft`, `baseUrl`, `tenant`, `pairUrl`, `qr`) and the two master fields are **absent from the response** — dropped, not blanked, so it is obvious in the network tab. Terminal and GUI callers send the master bearer, so they see no change. Covered by `bridge/test/pairing-routes.test.js`.
- **Every door into the web app now wears the same armour.** The web app has two entrances — the Worker, and the static files the bridge serves itself through the tunnel — and only the Worker had a CSP. The tunnel door, which is exactly where the very first pairing QR points, served the app bare. `bridge/src/static.js` now sends the **same** `content-security-policy`, and `x-content-type-options: nosniff` + `referrer-policy: no-referrer` were added to the Worker and to `web/public/_headers` so all three copies are identical. `bridge/test/static-headers.test.js` asserts the bridge copy matches the other two directive by directive: change the CSP in one place and that test names the two you forgot.
- **`POST /api/pair` is rate-limited per real IP (10/min).** It had no limit at the Worker, and the bridge's own limiter is nearly useless through a tunnel: every relayed request arrives as `127.0.0.1`, so that bucket is shared by the whole internet — a stranger who knows the room name (it rides in every QR link) could fill it and lock the owner out of pairing a new phone. The Worker is the only place a trustworthy address exists (`cf-connecting-ip`), so the check lives there; the bridge keeps its limiter as a second hat for the direct tunnel. The gate runs *after* the room is parsed, so a roomless request still falls through to `400 tenant_required` and nothing legitimate is swallowed.
- **Room creation can be switched off (`ALLOW_ROOM_CREATE=0`).** `POST /api/tenant/create` is self-serve by design, but one IP can claim all 50 KV room slots in about ten minutes and then nobody can create a room again until it is cleared by hand. Set the worker variable `ALLOW_ROOM_CREATE=0` (dashboard or `wrangler`) and the route answers `403 room_create_disabled` before it even reads the body — no new room, and no re-provisioning of an existing one (a machine that re-posts `/api/tenant/create` at first run gets the 403 too; sign-in itself is a different route, `POST /api/pair/tenant`, and keeps working). **Unset or `1` = today's behaviour**, so nothing changes until someone deliberately sets it. The same route also closes the name race that comes with leaving the door open: KV has no compare-and-set, so two creates for one name could both find it free and both write, last one winning. The worker now reads the record back after writing and, if the stored secret is not the one it just wrote, someone slipped in between and the name is no longer yours — it answers `409 taken` on the spot instead of returning `created` and leaving your bridge to fail registration later with a confusing 401. This is detection, not prevention (blocking it outright would need a Durable Object), and a read that comes back empty is never called a takeover, so KV's per-colocation lag cannot cry wolf. ⚠️ **Setting `ALLOW_ROOM_CREATE=0` breaks GUI self-provisioning.** The GUI creates the machine's room on first run via `POST /api/tenant/create` and reads the response with `HttpWebRequest.GetResponse()` (`desktop/src/OpenPocket.cs:854`), which **throws** on a 403 — the catch at line 871 puts the raw .NET text ("The remote server returned an error: (403) Forbidden") on screen, never the `room_create_disabled` code, so the owner sees an unexplained provisioning failure and **no room is written**. The GUI has no second self-provisioning path, so keep the flag off only when you provision rooms out of band and never expect a new machine to register; sign-in of already-provisioned machines is a different route and keeps working.

**Deployed 05/10**: the web bundle was rebuilt first (`npm --prefix web run build`), so `web/dist/_headers` carries all three headers on both deploy paths (the Worker uploads `web/dist`, the bridge serves it). The ⚠️ staleness warning recorded earlier in this pass is resolved.

The three risks this pass had deliberately **not** changed — the `?_t=` token on GET, plaintext secrets at rest, and cloudflared without integrity verification — were all closed in the next pass the same day; see the section below. Full reasoning, evidence and per-fix design: [docs/SECURITY-FIX-SPEC-2026-10-04.md](./docs/SECURITY-FIX-SPEC-2026-10-04.md).

## Remaining-risk closure pass (2026-10-05) — committed, not yet deployed

The 04/10 audit ended with a list of accepted risks and small debts. With only the owner running the app, breaking changes are cheap, so a parallel 8-agent pass closed the list. Each fix ships with its own test, six of the guards were mutation-verified (guard removed → the matching test goes red → guard restored, diff unchanged), and three independent reviewers read the result.

- **The `?_t=` query token is gone.** `requestToken` (`bridge/src/auth.js`) reads the `Authorization: Bearer` header and nothing else — the query branch that kept old cached PWA bundles alive was the one place a permanent key could still ride a URL (browser history, proxy access logs, `Referer`). `bridge/test/auth-query-token.test.js` locks it (query token → 401 even for a valid key; header → 200), and the older expectations in `bridge/test/routes.test.js` / `bridge/test/bridge.test.js` were rewritten to assert the query is dead.
- **cloudflared is pinned and hash-verified.** `bridge/src/tunnel.js` downloads a **pinned release** (`2026.9.3`) instead of `releases/latest`, and verifies the SHA-256 recorded in the release's asset digest (`f096265e…7e2e`) before the bytes ever touch disk — and re-verifies the cached binary on every start, deleting a tampered file. `CLOUDFLARED_URL` / `CLOUDFLARED_SHA256` env vars override both when upgrading. Covered by `bridge/test/tunnel-integrity.test.js`. Note: a cached binary from an older release fails the check once and is re-downloaded (~50 MB, one time).
- **KV no longer holds room passwords.** `worker/src/index.js` stores `secretHash` (sha256, timing-safe compare) instead of the raw password; records written by the old `worker/scripts/tenant.mjs` (plaintext `secret`) still sign in and are upgraded to `secretHash` on the first successful login — no migration script, no downtime. A KV dump no longer yields any usable password. Covered by `worker/test/relay.test.mjs` (`SECRET-1` cases assert no plaintext ever lands in KV and a failed guess never writes).
- **Rate limits are scoped per room.** The pair buckets used to key on the public IP alone, so households behind one NAT shared ten attempts. Now `rateLimited()` takes the room as scope (`pair-tenant`, `pair`), with a raw per-IP ceiling (30/min on `pair-tenant`) so an attacker rotating invented room names still burns only their own bucket and cannot drain the shared KV read quota. Covered by `LIMIT-1` cases.
- **`ALLOW_ROOM_CREATE` parses loosely.** `"0"`, `"false"`, `"no"`, `"off"` (any case, trimmed) and a numeric `0` all close the door; unset, `"1"`, `"true"`, `"yes"`, `"on"` keep it open. No more guessing the dashboard's quoting.
- **The desktop GUI explains provisioning failures.** `desktop/src/OpenPocket.cs` reads the HTTP status + JSON `code` out of the error response and shows a sentence with the fix ("Room creation is turned off on the worker…", "Too many attempts — wait a minute…"), and a `409 taken` now retries with a fresh random room name (up to 3 times) instead of surfacing the raw .NET text. Compile-gated by `desktop/build.bat`.
- **Config file permissions tightened, tokens redacted in logs.** `saveConfig` hardens `config.json` after every write (chmod 600 off-Windows; `icacls` removing inherited ACLs on Windows, best-effort, never fatal). `bridge/src/log-safe.js` (`redactUrl` / `redactSecrets`) strips `#t=` tokens and `?_t=` from every URL the bridge prints, and error paths run through a token-pattern scrubber — the master key can no longer land in `bridge-task.log`. Covered by `bridge/test/config-secrets.test.js` and `bridge/test/log-redaction.test.js`.
- **The owner token survives restarts.** `ensureOwnerToken` (`bridge/src/bootstrap.js`) re-inserts the hash of the raw token it already holds when `tokens.json` loses the entry, instead of minting a new token and forcing yet another OpenWork restart (the 04/10 `restartRequired` loop). Covered by `bridge/test/bootstrap-owner-token.test.js`.
- **Service worker bumped to v55** so installed PWAs pull a bundle from the post-`?_t=` world on their next open.

Test floor after the pass: bridge **111** (was 86), worker **48** (was 18), web **432** (the −28 is the parallel session's `session-organize` removal, not this pass). This pass is committed but **not deployed**: one `wrangler deploy` + one web rebuild + one bridge restart bring it live.

## Reliability checks (2026-09-18, local changes)

- Listener retries share one counter: at most ten retries, 400 ms apart. The startup smoke test runs a real bridge process against temporary bridge/OpenWork data directories, releases a deliberately occupied port, and checks authenticated/unauthenticated HTTP responses.
- Background stdout no longer prints pairing codes, QR payloads or the master key. Interactive terminals and the authenticated pairing-code API still support pairing.
- Roomless pairing is refused at the worker: 400 `tenant_required` for a tenantless `POST /api/pair` / `GET /api/state` (invalid JSON included) instead of relaying a stranger's code/key to any machine.
- `web/public/_headers` supplies the same CSP to Cloudflare's asset-first path without routing every static request through the Worker. Build output includes this file; production headers require deployment verification.
- Local verification commands: `npm --prefix bridge test` (111 tests), `node --test worker/test/*.test.mjs` (48 tests), `npm --prefix web test` (432 tests), and `npm --prefix web run build`. These do not publish a release or restart the installed bridge.

## Bridge routing (2026-10-04)

The bridge's HTTP surface is a **declared route table**, not an if-chain:
`bridge/src/router.js` matches in order (exact path, RegExp, or `"*/prefix"`,
with `method: "*"` for the catch-all proxy) over handlers grouped by concern in
`bridge/src/routes/`. `bridge/src/app.js` exposes `createApp(deps)` → `{server,
handleRequest, ctx, routes}`; `bridge/src/index.js` only boots, discovers and
listens, and hands over its singletons. Two rules the structure depends on, so
don't "tidy" them away:

- **Auth-gate order.** `/api/pair` and `/api/pair/tenant` run *before* the gate — a stranger must be able to pair in. Everything else under `/api/` needs the master `owm_` key or a device `owd_` key (the `Authorization` header — the only path since 2026-10-05; the `?_t=` query fallback is gone). An unknown `/api/` path answers **401 without a token** and only `404 not_found` once you hold one, so the phone cannot probe which endpoints exist.
- **`ctx.tunnel` is a holder object, not a captured function.** `index.js` swaps in the real cloudflared controller after `startQuickTunnel` resolves; routes must read through the holder or they will keep the boot-time stub.

`bridge/test/routes.test.js` covers the table over real HTTP with fake deps. Tests in that file must set `OPENWORK_BRIDGE_DIR` to a temp dir — `PairingService` and `saveConfig` write to the real `%APPDATA%` store otherwise.

## Quick troubleshooting

| Symptom | Fix |
|---|---|
| Writes fail with `"Sign in to verify policy"` | Open OpenWork desktop and sign in/verify again (cloud session expired) |
| Prompt sent but no reply comes back | No model picked in chat — a model is mandatory |
| openwork-server not found | Is OpenWork desktop actually running? |
| Phone says OpenWork not found, or "mở từ xa" always fails | Settings → **OpenWork trên máy tính**: tap one of the suggested paths (or type your own) → **Chỉ đường dẫn**. It accepts only a file literally named `OpenWork.exe`. No OpenWork on the machine at all? Copy the folder elsewhere or install it — the bridge can only launch a real install |
| Phone says "tunnel_down — đang chờ Cloudflare mở lại" | The Quick Tunnel is rate-limited (429). Wait out the countdown shown in `openpocket status` / the OpenPocket GUI — **do NOT restart the bridge**, each restart extends the ban. It lifts by itself and the phone reconnects alone. Impatient / countdown stale (IP changed)? The GUI **Restart tunnel** icon tries a fresh tunnel right now — the bridge stays up, and a still-active ban just 429s back into its own backoff |
| Other | Open [CODE_SUMMARY.md](./CODE_SUMMARY.md) — the full lookup table |

## Development

```bash
cd bridge && npm test                                   # 86 unit tests
node bridge/scripts/e2e-live.mjs <wsId> <provider> <model>   # live E2E
cd web && npm run dev                                   # dev server (proxies /api through the bridge)
cd web && npm run build && cd ../worker && npx wrangler deploy # build + deploy the "fixed URL" worker (openpocket)
cd worker && node scripts/tenant.mjs add <user> "Name"   # issue a multi-tenant room (list / revoke to manage)
```

## Publishing & privacy

`git push` from this repo is intercepted by a repo-local pre-push hook (`.githooks/pre-push`, enabled via `core.hooksPath` — a machine-local, gitignored file that is NOT part of the published repo): it builds a sanitized mirror of the history and force-pushes that mirror to origin, then cancels the raw push. The local repo keeps the originals; raw refs never leave the machine. Don't bypass with `--no-verify`.

The mirror is scrubbed of:

| What | Becomes |
| --- | --- |
| Commit author + committer identity | `ngochuyN-hash` / noreply email (on **every** commit) |
| The real worker URL | `https://YOUR-WORKER.workers.dev` |
| The real name and the Cloudflare account name | `user` / `example` |
| Real email addresses (gmail/outlook/hotmail/yahoo/icloud) | `user@example.com` |
| The Cloudflare KV namespace id | all zeros |
| `C:\Users\<name>` paths | `C:SERS<USER>

Three properties make this hold up: the wash is **repo-wide** (every text file in every commit, not a hand-kept file list, so a new file cannot slip past); it is **case-insensitive** (a real address starts with a capital, and a lowercase-only pattern let it through); and `.wrangler` caches are deleted from every commit (they hold the Cloudflare account record). After rewriting, a safety gate greps the whole rewritten history case-insensitively and **blocks the push**, listing the offending files, if any personal string survives. Run `WASHER_DRYRUN=1 sh .githooks/pre-push origin main main` to build the mirror and check the gate without pushing.

To add a new private value, add one line to `$WASH_SED` and `$WASH_GREP` in `.githooks/pre-push` — both read the same list, so the wash and the gate cannot drift apart.

## Project rules

> 📌 **Every time code/structure/behavior changes, `README.md` AND `CODE_SUMMARY.md` MUST be updated in the same commit.** README = the outside (usage, features); CODE_SUMMARY = the inside (where to fix, API map). Documentation is written in English.
