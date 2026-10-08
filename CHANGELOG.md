# CHANGELOG — OpenWork Mobile

Per-milestone log (newest first), split out of CODE_SUMMARY.md so that file can stay a map of the code as it is now. Each entry records what changed, why, and what verified it.

## Repo health pass — 2026-10-08 (bridge + web + CI + docs)

- `bridge/src/openwork-launch.js`: `isOpenWorkExeName` uses `path.win32.basename`. Plain `basename` cannot split `C:\...\OpenWork.exe` on Linux/macOS, so 2 bridge tests failed off-Windows; the guard for `POST /api/openwork/path` now behaves identically everywhere.
- `.github/workflows/ci.yml` (new): bridge, worker and web tests plus `vite build` on every push to `main` and every PR. Totals at this date: bridge 139, web 444, worker 56.
- Web: Files, Search and Settings load as separate chunks (`components/lazy-page.jsx`). Main JS 191 kB → 163 kB (gzip 63 → 54 kB); the three chunks are 7–12 kB each. `marked` was *not* split out: `lib/markdown.js` renders synchronously inside the chat bubble and `marked` is the same engine the desktop app uses on purpose. Service worker bumped to `owm-shell-v56`. Checked in headless Chromium against a stub server: `#/settings` and `#/ws/x/files` render, the chunks are requested on demand, no page errors.
- `desktop/src/BridgeProcess.cs`, `OpenPocketSetup.cs`: `where.exe` waits capped at 5 s (closes O1). Not compiled in this pass — no `csc` on the Linux runner.
- Docs: this file's milestone log moved to `CHANGELOG.md`; dated hardening passes, the dormant multi-tenant notes and the removed OTA channel moved from README to `docs/HISTORY.md`; README size and test numbers corrected; the security-fix spec status table now matches git (all four FIXes committed).

## Worker contract signed: /__register, room-creation codes and KV shelf labels get one source — 2026-10-08 (shared + worker + bridge + desktop)

The last cross-tier knowledge living outside `shared/contract.js` moved into it: the bridge→worker tunnel-registration door (`REGISTER_PATH = "/__register"` — payload `{url}` / `{url, tenant}` / `{url:"", tunnelDown:true, retryAt}`; the legacy `{error}` envelope is documented as deliberate — the bridge only reads `response.ok`), `normalizeTenant()` (the trim+lowercase room-name rule previously hand-rolled 4× in the worker plus once in `bridge/src/lookup.js`), and the three room-creation codes the desktop exe string-matched in `Provisioning.ErrorText` — `taken`, `full`, `room_create_disabled` joined `ErrorCode`, and the worker now emits them through the constants. The worker's KV shelf labels (`machine:`/`tenant:` prefixes across ~20 sites, plus a string-slice re-parse inside `relay()`) collapsed into one `kvKey` builder; the exe stopped hand-typing codes — `desktop/gen-host-contract.mjs` also renders `src/ErrorCode.cs` from `shared/contract.js` (gitignored, same pattern as `HostContract.cs`). Worker-internal codes (`unpaired`, `bridge_unreachable`, `invalid_user`, `kv_error`, …) deliberately stay local literals — nothing outside the worker compares them. Tests: new `worker/test/contract-pins.test.mjs` (3), a source-scan test in `bridge/test/lookup.test.js` (its wire-side assertions already pinned path + header), the web fixture pins the new canonical values. Verified: bridge 139/139, worker 56/56, web 444/444, `build.bat` + `build-test.bat` compile with the generated file. Behavior unchanged — the next `wrangler deploy` ships identical responses.

## Host contract: one source for the host knowledge shared by C# and JS — 2026-10-07 (shared + bridge + desktop)

The knowledge both host sides must agree on — the bridge port (8788), the data-dir name (`openwork-bridge`), `config.json`, `bridge.pid`, the three log file names, the two scheduler task names, the config keys the GUI reads/writes (`mobileToken`, `port`, `lookupUrl`, `lookupSecret`, `lookupTenant`, `machineName`), and the tunnel shapes — used to be hand-copied between `desktop/src/*.cs` and `bridge/src/*.js`; a rename on one side degraded the GUI silently (blank tunnel status, ignored config writes). Now `shared/host-contract.js` (pure ESM, no imports) is the single source: bridge modules import it directly (`config.js`, `logwipe.js`, `autostart.js`, `tunnel.js`, `index.js`), and the desktop receives generated `desktop/src/HostContract.cs` (gitignored) produced at build time by `desktop/gen-host-contract.mjs` from `build.bat`/`build-test.bat` — the same pattern as `IdentityKeys.cs`. Consumers kept their locations; only literals became `HostContract.*` constants. `tunnel.js` also exposes the pure `tunnelStateSnapshot()` (the `/api/state` tunnel shape — the fallback file keeps `nextAttemptAt`, the API keeps `nextRetryAt`, on purpose) so the shape is testable. Drift protection: new `bridge/test/host-contract.test.js` (7 tests) pins the contract module's purity, the JS consumers' outputs (config defaults, `LOG_NAMES`, task names, the tunnel-state writer keys, the snapshot shape) and the generated C# content. Verified: bridge 138/138, `build-test.bat` compiles with the generated file (the main exe rebuild was pending while the GUI held `OpenPocket.exe` — rebuild on next close). Remaining cross-language seam, noted for a later pass: the desktop's `/api/*` path literals and the worker error codes the provisioning flow reads.

## Machine identity: one deep module; the 4-key whitelist is generated from one source — 2026-10-07 (bridge + desktop)

The two identity seams — `POST /api/machine/name` (web Settings) and `POST /api/config/identity` (desktop GUI) — each carried their own copy of the sanitize rule and each wrote `config.json` on its own; changing the rule meant remembering 2 places + 3 independent test pins. Now `bridge/src/identity.js` (`applyIdentity`) is the ONE deep module owning whitelist + sanitize + save + log, and both routes are thin adapters over it (web UI and endpoints unchanged). The 4-key whitelist itself lives in `shared/identity-keys.txt` — the single source the bridge reads at runtime AND that `desktop/build.bat`/`build-test.bat` compile into generated `desktop/src/IdentityKeys.cs` (gitignored, same pattern as `InviteKey.cs`); the GUI's `TrySaveViaBridge` now sends `IdentityKeys.All`, so a future 5th key added to the txt reaches both sides on the next build instead of being silently dropped by the GUI's hand-typed array. Tests: new `bridge/test/identity.test.js` pins the file and the rules (whitelist contents, machineName sanitize, trim/300 for the rest, no write when nothing applies); the existing route tests stay as adapter + auth coverage. Verified: bridge 121/121, web 444/444, worker 53/53, standalone csc compile of the changed GUI module against generated `IdentityKeys.cs`, and a real `build-test.bat` run. (The GUI half of this change landed in commit `85d26db`, was reverted by the parallel `tasks:` commit touching the same file, and is re-applied here.)

## Autostart is a built-in exe feature: self-heal on launch + battery-proof tasks + 5-minute watchdog — 2026-10-07 (desktop + bridge CLI)

The bridge died silently after the morning reboot and stayed dead until started by hand — **the laptop was running on battery** (`BatteryStatus=1`, 53%): every `schtasks /Create` task ships with `DisallowStartIfOnBatteries=true`, `StopIfGoingOnBatteries=true`, `StartWhenAvailable=false`, so the ONLOGON trigger was **silently skipped** while on battery, `/run` queued forever waiting for AC power, and a 5-minute watchdog fire counted as a missed run that never catches up. Stacked on top: a fast-startup boot/resume raises no new logon event, and the checkbox had been showing the task as ON because `Exists()` only asked "is the task there", not "does the task still work". Per the owner's order ("autostart should just be part of the exe"), launching `OpenPocket.exe` now guarantees the feature in the background (no UI freeze — each `schtasks` call can take seconds):

- **Tasks are created from XML, battery-proof**: `AutostartTask.BuildTaskXml()` writes the exact shape schtasks itself generates but with `DisallowStartIfOnBatteries=false`, `StopIfGoingOnBatteries=false`, `StartWhenAvailable=true`, registered via `schtasks /Create /XML`. `bridge/bin/openpocket.js` (`autostart --enable`, `watchdog --install`) uses the same template — two languages, one contract, keep them in sync.
- `AutostartTask.Healthy()` / `NeedsRepair()` read `schtasks /query /xml` and require a real `<LogonTrigger>` AND battery-proof settings. A task that exists but is broken is **recreated**; a task that doesn't exist is left alone — the checkbox stays the only creator from nothing (the old UX rule: never resurrect autostart the user turned off).
- `AutostartTask.EnableWatchdog()` installs **`OpenPocketBridgeWatchdog`** (5-minute repeat → hidden VBS → `node bridge\bin\openpocket.js ensure`): a bridge killed mid-session, a machine that came back without a logon event, or a missed logon on battery all recover within 5 minutes, no hands. It is **re-created on every launch while autostart is on** (idempotent `/F`) so old battery-hostile installs self-correct. Ticking the checkbox installs both tasks; unticking removes both.

## Pairing QR drawn as a fixed-size bitmap, not ASCII text — 2026-10-07 (desktop only)

| Symptom | Where it's fixed |
| --- | --- |
| The one-time QR and the permanent QR render at visibly different sizes, and the dialog resizes on every toggle | `QrAsciiRenderer.RenderBitmap()` + `SetQrImage()` in `desktop/src/PairingQrDialog.cs` — both codes are drawn into a bitmap targeting 260 logical px; integer-pixel cells land each code within ~1px of the other (246px vs 245px), so `Relayout()` no longer moves the lower blocks when toggling |

Why the sizes differed: `qrcode-terminal` auto-picks a larger QR version for longer payloads — the master URL (~122 chars, 41 modules) needs a bigger grid than the one-time URL (~76 chars, 33 modules), and the old rendering drew the ASCII in a fixed-size font, so more characters meant a physically larger code. The new `QrAsciiRenderer` (same file, bottom) decodes the ASCII back into the module matrix using the vendor's own palette semantics (`index.js`: ▀=top-white/bottom-black, ▄=top-black/bottom-white, █=both white, space=both black — note the dark modules print as SPACES because the library targets dark terminals, i.e. the old font rendering showed an inverted QR), strips the border line/columns the vendor adds, drops the white pad row for odd module counts, and fills black rectangles on a white canvas with a 4-module quiet zone, scaled by the monitor DPI (`CreateGraphics().DpiX`). Verified by a round-trip harness: bridge ASCII → parser → PNG → `jsqr` decodes both sample URLs exactly, finder polarity confirmed black-on-white; the parser's trailing-white-row trim must run as a `while` loop that stops at the first non-white row (a `for` with the decrement in the post-statement trims one row too many after `break`).

## CLI joins the shared contract for pairing URLs and tunnel state — 2026-10-07 (bridge CLI only)

| Symptom | Where it's fixed |
| --- | --- |
| Changing the pairing-link shape in `shared/contract.js` would silently miss `openpocket code` — it hand-assembled `#p=`/`#t=`/`&m=` outside the contract that calls itself "the only place that knows the link shape" | `bridge/bin/openpocket.js` (`code` command) builds both URLs via `buildPairingUrl` from `shared/contract.js`; output verified byte-identical for the tenant and tenant-less forms |
| `openpocket status` re-parsed `tunnel-state.json` with its own `JSON.parse` inside a try/catch | reads through `loadTunnelState()` from `bridge/src/tunnel.js` — the state file has one reader seam |

Also removes a stale header comment in `shared/contract.js` claiming the worker had not adopted the contract yet — `worker/src/index.js:30` imports it.

## Task Scheduler surface has ONE owner: the CLI — GUI shells out — 2026-10-07 (desktop + bridge CLI)

| Symptom | Where it's fixed |
| --- | --- |
| The battery-proof task XML, the no-BOM VBS wrappers and the task names existed as two hand-synced copies (C# + JS) held together by a comment promise — the exact logic behind the real 07/10 battery incident, with ZERO tests in both languages | `bridge/src/autostart.js` is the only owner: `buildTaskXml` / `writeTaskXml` (UTF-16LE BOM) / `buildTaskVbs` / `assessTaskXml` + the two trigger XML constants, pinned by `bridge/test/task-xml.test.js` (6 tests: flags, escaping, BOM, quoting, watchdog variant, assessment) |
| The GUI could not test any of it (no C# test harness) and string-matched `schtasks /query /xml` on its own | `desktop/src/AutostartTask.cs` is a thin adapter: it shells out to `openpocket tasks --json` (both tasks' status in one node spawn), `autostart --enable/--disable/--run --json`, `watchdog --install/--uninstall` and parses JSON — no schtasks parsing or XML building left in C# |
| The watchdog task was graded by LogonTrigger criteria, so a healthy watchdog read as permanently "unhealthy" | `assessTaskXml(xml, triggerTag)` grades autostart by `LogonTrigger` and the watchdog by `TimeTrigger` |

Dead interface removed with its test: `buildAutostartAction` (a /TR-style command string) survived only to feed its own assertion. GUI semantics unchanged: never create a missing task (the self-heal repairs only an existing broken one), a failed `/run` must surface as an error, unticking removes both tasks.

## GUI reads tunnel state over the bridge API; the file read is fallback only — 2026-10-07 (desktop)

| Symptom | Where it's fixed |
| --- | --- |
| The GUI reached past the bridge's HTTP interface into on-disk internals: it regex-"parsed" `tunnel-state.json` (`Regex.IsMatch`) and scraped the cloudflared log tail — the third independent copy of the trycloudflare URL regex (the others live in `bridge/src/tunnel.js` and `worker/src/index.js`) | `CheckStatus` in `desktop/src/OpenPocket.cs` asks `GET /api/state` — tunnel phase/URL/nextRetryAt straight from the bridge — through the new `BridgeHttp.GetSync` (the adapter was POST-only; that absence is why the GUI scraped). The GET runs on the UI thread so its timeout is 2s; localhost normally answers in <50ms |
| A bridge-side shape change (renamed/nested field) would have broken the GUI silently — nothing pinned the file contract | `TunnelState.cs` JSON-parses the fallback file with `JavaScriptSerializer` (a rename now degrades to an empty fallback instead of a regex miss); `UrlFromLog` is deleted — a task-run bridge never printed the URL to its log, so the 05/10 file fix had already made it dead weight |

Display semantics: while the bridge runs and the tunnel phase is "starting", the GUI now shows "Connecting..." instead of the stale "up" URL the old file/log fallbacks could keep painting green.

## File-manager seam gets a deliberate error→status map, pinned by route tests — 2026-10-07 (bridge)

| Symptom | Where it's fixed |
| --- | --- |
| Every fs error the route didn't special-case became 403 "no permission" — an internal failure (EIO…) presented to the client as a permission problem and misled debugging | `fsStatus(error, fallback)` in `bridge/src/routes/fs.js`: ENOENT/ENOTDIR→404, EEXIST/EINVAL→400, EACCES/EPERM→403, anything else→500 — one map for both `/api/fs/ls` and `/api/fs/mkdir` |
| The mapping floated free: `fslist.js` had unit tests but the HTTP seam had none | `bridge/test/fs-routes.test.js` boots the real app (the `createApp` harness) and pins each row over HTTP: 401 without token, 200 roots, 404 ENOENT/ENOTDIR, 200/400 EEXIST/400 EINVAL for mkdir — plus a unit test of the map itself |

## Desktop GUI split into modules; config.json has ONE writer — 2026-10-06 (desktop + bridge)

Candidates 7 + 3 of the 03/10 architecture review, closed together. `desktop/src/OpenPocket.cs` went 1998 → **1051 lines** and now holds only the main form (layout + orchestration); everything with a clean seam moved verbatim (comments kept) into its own file under `desktop/src/`: **Ui.cs** (224 — `RoundedButton` self-drawn buttons, `ButtonKind`, `Ui.RoundedPath`, `Ui.SafeInvoke`, the app icon), **BridgeConfig.cs** (70 — config path/data dir/load + port/token readers), **BridgeProcess.cs** (203 — find node.exe, dependency presence, port probe, direct start, the precise WMI stop, log wipe), **TunnelState.cs** (100 — tunnel URL from `tunnel-state.json` + 32 KB log tail + 429 backoff minutes), **AutostartTask.cs** (127 — schtasks query/run/create (.vbs without BOM)/delete), **BridgeHttp.cs** (48 — POST localhost with the Bearer master token), **Provisioning.cs** (103 — pure helpers of the machine-identity flow: room/secret minting, HTTP error extraction, fix-carrying error sentences), **PairingQrDialog.cs** (285 — the QR popup). `build.bat`/`build-test.bat` compile all ten files (C# 5 — no inline `out var`).

Candidate 3: `config.json` used to have TWO writers — the bridge (`saveConfig`) and the GUI writing the file directly. The GUI's saves now go through **`POST /api/config/identity`** (`bridge/src/routes/config.js`, wired into `app.js`): **master token only** (a paired device gets `403 master_only`), a **closed 4-key whitelist** (`lookupUrl`, `lookupTenant`, `lookupSecret`, `machineName` — `mobileToken`/`ownerToken`/`port` can never be set through it), `machineName` sanitized exactly like `/api/machine/name`, and the log line records key NAMES only (the room secret never reaches a log). The GUI applies the same whitelist before posting and **falls back to the direct file write when the bridge is not running or refuses** — a new GUI + an old bridge keeps the old behavior, and a write-while-bridge-dead is safe by definition (nobody else holds the file). The bridge stays the single writer with its one serializer + one ACL pass. New tests: `bridge/test/config-routes.test.js` (6 — whitelist, master-only, sanitization, invalid bodies, no-token 401). Verified: bridge **111 → 117/117**, both `desktop\build.bat` and `build-test.bat` compile clean.

## chat.jsx split into modules — 2026-10-06 (web only)

`web/src/pages/chat.jsx` was 2183 lines carrying ~10 responsibilities (the 03/10 architecture review, candidate 5). The split moves every piece that has a clean seam, keeping behavior identical (cut-paste, comments preserved): **pure logic with tests** → `web/src/lib/chat-events.js` (47 lines: `eventSessionId`/`sameSession`/`eventProps` — the SSE event identity rules) and `web/src/lib/chat-file-refs.js` (89 lines: `findFileRefsInText`/`collectFileRefs`/`baseNameOf`/`dirOf`/`makeFileHref` — which also kills the duplicated `FILE_HINT_EXT` regex; both copies now import the one in `lib/markdown.js`); **render parts** → `web/src/components/chat-message-parts.jsx` (270 lines: `MessageBubble`, `ToolRow`, `ThoughtRow`, `FileRefCard`, `MarkdownText`); **sheets** → `web/src/components/chat-sheets.jsx` (261 lines: `RenameSheet`, `MessageActionSheet`, `AgentPicker`, `QuestionCard`). `chat.jsx` is down to ~1557 lines and now holds only the session state machine (stream buffer, outbox, permission, revert/edit flow) — that machine is the remaining, deepest seam and needs its own design session before anyone touches it. New tests: `web/test/chat-events.test.js` (3) + `web/test/chat-file-refs.test.js` (5) — web suite 435 → **443/443**, bridge 111/111, `vite build` clean. The only importer of `chat.jsx` is `app.jsx` (`ChatPage`).

## Shared API contract `shared/contract.js` — 2026-10-06 (bridge + web)

The pairing link shapes (`/#p=`, `/#t=`, `&m=`), the `?_m=` query fallback, the three `x-owm-*` headers, the cross-layer error codes and the token prefix list (`owm_/owd_/owt_`) now have ONE source of truth: `shared/contract.js` (pure ESM, zero imports — **all three runtimes import it**: bridge and the Vite-bundled web directly, the worker through esbuild bundling). `buildPairingUrl()` is the single place that knows what a pairing/master link looks like: bridge `index.js` and `routes/pairing.js` build through it (the hand-built template strings are gone, and the now-unused `tenantHashSuffix` plumb through `createApp` was deleted along with its test fakes). `web/src/api.js` reads the hash keys and sends `x-owm-tenant` through the constants; `lib/route.js` builds its tenant regex from `TENANT_HASH_KEY`; `pages/pairing.jsx` compares `e.code` against `ErrorCode.TENANT_REQUIRED` and derives both its master-link regex and the bare-key shape check from the contract; `bridge/src/log-safe.js` derives its secret-key set and the `TOKEN_LIKE` redaction regex from it; **`worker/src/index.js` (06/10 evening) emits every cross-layer code and reads every header through `ErrorCode`/header constants — all floating literals removed**. Drift protection: `web/test/contract-fixture.test.js` locks the canonical values themselves, asserts the worker imports the file AND carries no floating cross-layer literals, and cross-checks that `worker/test/relay.test.mjs` still asserts the canonical values from the HTTP side. **07/10: `web/src/lib/sse.js` reads its room header through `HEADER_TENANT` too — the last floating header literal in web is gone, with a fixture assertion of its own.** Verified: worker 53/53, bridge 111/111, web 443/443 (8 fixture tests total), `vite build` clean with the out-of-root import. The next `wrangler deploy` ships the worker change.

## Desktop GUI stuck on "Cloudflare Tunnel: Connecting..." — 2026-10-05 (desktop only)

Symptom: with the bridge running as the scheduled task (the normal case), the
OpenPocket GUI status card stayed amber on **"Cloudflare Tunnel: Connecting..."**
forever, even though the tunnel was up and the phone could reach the bridge
through it.

Root cause: `2a202a3` (the simplification pivot) made `printPairing()` return
early when stdout is not a TTY — correct for keeping tokens/QRs out of log
files, but a task-run bridge therefore never prints the
`[tunnel] NEW public URL` line into `bridge-task.log`. The GUI read the tunnel
URL **only** by scanning the log tail, so it found nothing and fell back to
"Connecting...".

Fix (`desktop/src/OpenPocket.cs`): the GUI now reads the URL from
`%APPDATA%/openwork-bridge/tunnel-state.json` first — the bridge writes
`phase: "up"` + the live `url` there on every capture, and the GUI already read
that file for the 429-backoff hint — and only falls back to the log scan. The
bridge is untouched, so the running tunnel URL stays valid and phones do not
need to re-pair. Rebuilt `bin/OpenPocket.exe`, swapped the live GUI (one UAC
prompt), verified on screen: green tunnel line with the live URL.

## Denser session list, filter row and bottom nav — 2026-10-04 (web only)

Owner: *"mỗi tab session cũng đang cao và to quá"*. Three surfaces shrank;
measured with `getBoundingClientRect` in a real browser (A/B page, built CSS):

| Surface | Before | After |
|---|---|---|
| Session card | 128px | 84px |
| Filter chip row (Sessions) | 144px (3 wrapped rows) | 34px (one scrolling row) |
| Bottom nav bar | 65px | 49px |

**Root cause of the tall card.** Each card holds three small icon buttons
(pin / assign-group / archive) built as `btn small ghost btn-icon`, and
`button.btn.small` carries `min-height: 44px`. Each button stretched its whole
`.row-between` row to 44px, so a 15px title sat inside a 126px box. The
padding was the second half of the problem: `.card` uses `var(--sp-4)` = 16px.

**What changed** (all in `web/src/styles.css` unless noted):

- New `.card.tap.dense` variant, applied in `pages/home.jsx` and
  `pages/sessions.jsx` only. `.card` itself is untouched — Workspace and Files
  cards share it. Padding `8px 10px`, icon buttons 32×32 with `padding: 0` and
  a transparent border that reappears on `:active`, title 14.5px/1.35,
  `.row-between + .row-between` margin 2px, swipe gap `--sp-2`.
- The JSX **inline `style="margin-top:6px"` on the second row had to be
  removed** in both pages — an inline style beats the stylesheet, so the CSS
  rule for that gap would never have applied.
- New `.fs-chips.scroll` variant (`nowrap` + `overflow-x: auto`, hidden
  scrollbar, chips 34px), modelled on the existing `.composer-pills`. Attached
  only in `sessions.jsx`; the folder picker in `workspaces.jsx` keeps the
  wrapping `.fs-chips`.
- Bottom nav: button `min-height` 50→34, padding `4px 8px`→`2px 6px`, font
  11→10.5px, gap 2→1px, `.nav-pill` `4px 16px`→`2px 12px`, svg 20→18px, bar
  padding 6→4px.
- Two positioning constants move **with** the nav, or content gets covered:
  `.view` padding-bottom `calc(108px + sab)` → `88px`, `.fab` bottom
  `calc(86px + sab)` → `66px`. Changing `.bottomnav` without these is the trap.

`pages/search.jsx` renders session rows too but was left alone on purpose: its
card is a different three-row shape with no 44px buttons inside, so it never
had the problem.

**Touch target rule.** This is a deliberate, owner-approved exception to the
project's ≥44px rule: secondary icon actions inside a dense list are 32px.
Primary actions (open a session, FAB, filter chips) stay ≥44px. Recorded in
`.zcode/skills/pwa-workspace-ui/SKILL.md` and `references/tokens.md`, whose nav
figures were already stale (they said 10px bottom offset; the code has used 6px
since v5.5b).

## Security patch round — 2026-10-04 (bridge + worker, NOT deployed)

Spec: `docs/SECURITY-FIX-SPEC-2026-10-04.md` — a full three-tier audit (worker →
bridge → web) that also probed the **running** bridge: every token-less API
answers 401 and 38/38 XSS cases pass, so the verdict is **no critical hole** (no
XSS, no SSRF, no arbitrary file read). The four items below are hardening, in the
spec's own priority order. FIX-1 and FIX-2 are bridge-only and therefore testable
locally; FIX-3 and FIX-4 only exist once the worker is deployed.

| # | Symptom | Where it is fixed | Reach the phone |
|---|---|---|---|
| FIX-1 | A paired phone calls `GET /api/pairing-code` and reads the **master token** out of `masterUrl` / `masterQr` | `bridge/src/routes/pairing.js` — `pairingCode({res, device})` now takes `device` (app.js:76 already passed it), builds the payload without the master part and appends `masterUrl`/`masterQr` **only when `isMaster = !device`** | restart bridge |
| FIX-2 | The web app opened through the **tunnel** URL carries no CSP at all — the shield only existed on the worker door | `bridge/src/static.js` — new `SECURITY_HEADERS` spread into the static `writeHead(200, …)`; the same two headers added to `worker/src/index.js` `withSecurityHeaders()` and `web/public/_headers` | restart bridge + deploy worker |
| FIX-3 | A stranger who knows the room name can flood the pairing bucket (everyone behind cloudflared is `127.0.0.1` to the bridge) | `worker/src/index.js` — `POST /api/pair` with a room now goes through `rateLimited(request, "pair", 10)` → 429 `rate_limited` | deploy worker |
| FIX-4 | Anyone knowing the worker URL can self-create rooms, and two concurrent creates race for one name | `worker/src/index.js` — env flag `ALLOW_ROOM_CREATE`; unset/`"1"` = open exactly as before, `"0"` → 403 `room_create_disabled`; **plus** read-after-write after the `put` — a record read back whose secret differs from the one just written → 409 `taken` | deploy worker (+ set the var) |
| FIX-5 | Even with `ALLOW_ROOM_CREATE` on, anyone who knows the worker URL can still self-create rooms — the switch was all-or-nothing and the owner wants "only my exe opens rooms" | `worker/src/index.js` — `/api/tenant/create` now requires an `x-owm-invite` header matching the `ROOM_CREATE_KEY` dashboard secret (checked **after** the rate limit, so key probes still burn their 5/min bucket; secret unset → door closed). `desktop/` bakes the key into the exe at build time (gitignored `invite.key` → generated `src/InviteKey.cs`) and provisioning sends it; a build from the public repo carries no key → 403 `invite_required` | deploy worker (+ `wrangler secret put ROOM_CREATE_KEY`) + rebuild the exe |

**FIX-1 — the master token must not travel to a revocable key.** The project's
security model is *"lose the phone → revoke its key, you're clean"*, and this hole
voided it: `app.js` accepts both a master token (`device = null`) and a device key
(`device ≠ null`) on `/api/pairing-code`, so **one single call before the phone is
revoked** handed the attacker the permanent `owm_` master — unrevocable from the
phone, rotatable only by hand-editing `config.json` and re-pairing everything. The
two fields are now **omitted entirely** for a device key (not returned as `""` —
easy to spot in the network tab), while the pairing part (`code`, `codeFormatted`,
`pairUrl`, `qr`, `secondsLeft`) is unchanged because it was always meant for the
device. Consumers re-checked against real code, none of them lost anything: the
desktop `FetchLiveCode` and CLI `openpocket code` both authenticate with
`config.mobileToken` (master → still get the master QR), the web Settings card uses
a device key and never rendered those two fields anyway, and a legacy `?_t=` master
still resolves to `device = null`.

**FIX-2 — the web app has two doors and only one was armoured.** `bridge/src/static.js`
serves `web/dist` itself for `*.trycloudflare.com` / a self-hosted `publicUrl`, and
that path answered with **no CSP, no nosniff, no frame guard** (curl-verified live),
while the worker door had CSP since the 2026-09-13 hardening round. So the
"even if XSS got through, the dynamic script can't run and can't reach the token in
localStorage" argument only held on one door — and the tunnel door is the one a QR
points at before the machine is paired. The CSP string is now duplicated in three
places by design (`static.js`, the worker constant, `_headers`); **all three must
stay identical**, because diverging in one leaves the other two armoured and one
bare. The error branches (403/404/500) deliberately do not get the headers — they
answer `text/plain`/JSON, not the app shell, so CSP has nothing to police there.

**FIX-3 — the rate limit has to live where the IP can be trusted.** The bridge's
`pairLimiter` (10/min) counts `req.socket.remoteAddress`, and *every* internet
request arrives through cloudflared as `127.0.0.1` — so the bucket is shared by the
whole internet, and a stranger who knows the room name (it sits in every QR link)
can fill it so the owner cannot pair a new phone. It cannot be fixed on the bridge:
the relay forwards client headers verbatim (except `host`), so a forged
`x-forwarded-for` walks straight past a bridge-side check, and cloudflared itself
only sees the worker's egress IP. The one trustworthy source is `cf-connecting-ip`,
which only the worker sees — hence the limit moved there (10/min/IP, the same
ceiling as `/api/pair/tenant`, reusing the existing Cache-API limiter). The guard
sits **after** the room is extracted, so a room-less request still falls through to
the `tenant_required` branch instead of being swallowed by a 429. The bridge keeps
its own limiter as a second helmet for the direct-tunnel path.

**FIX-4 — the room door is now closable, and the race is detected but not
prevented.** Both plan B and plan C of the spec are in.
`ALLOW_ROOM_CREATE=0` (a worker env var) turns new-room creation into 403
`room_create_disabled` before the body is read, while leaving existing rooms and
their sign-in completely untouched — unset or `"1"` = open exactly as before, so
nobody's behaviour changes until someone deliberately sets the var.
Plan C then re-reads the record after `put` and compares it with
`sameSecret(secret, saved.secret)`: KV has no CAS, so two concurrent creates of one
name can still both see `existing = null` and both `put` (last write wins) — the
read-after-write turns that silent loss into an honest **409 `taken`** at the point
of creation instead of an inexplicable 401 at bridge registration minutes later.
Two honest limits, recorded so nobody over-reads it: it **detects** the race, it does
not **prevent** it (a true guard needs a Durable Object — plan D, judged not worth
it), and because KV is only eventually consistent across colos it stays quiet when
the read comes back empty (`null`) rather than cry "taken" on a room it never saw.
The blast radius of what slips through is what the spec measured — the owner's
bridge fails to register and the phone gets a wrong-password error; no data leak, no
redirect to a stranger's machine.

**FIX-5 — creating a room now needs the owner's exe, not just the URL.** The owner's
call: "only my exe should be able to open rooms". `/api/tenant/create` requires an
`x-owm-invite` header that must match the worker's `ROOM_CREATE_KEY` secret
(dashboard-only, never in the repo), compared through `sameSecret` (length check +
constant-time). The check sits **after** the `create-room` rate limit, so invite
guessing still burns the 5/min/IP bucket, and the `ALLOW_ROOM_CREATE=0` hard-off
still overrides everything. The desktop build scripts generate `src/InviteKey.cs`
from the gitignored `desktop/invite.key` before csc runs (no key file → the exe
still builds but warns), and silent provisioning sends the key as a request header;
`ProvisionErrorText` maps the new 403 to two distinct sentences — "build has no
invite key" vs "the worker only accepts the owner's build". Honest limit: a key
baked into a distributed exe is extractable by a determined reverse engineer —
this is an invite gate for the friend circle, not crypto against attackers.
Tests: `worker/test/relay.test.mjs` gains 5 cases (stranger exe without the header /
secret unset / wrong key / correct key creates / `ALLOW_ROOM_CREATE=0` precedence
over a valid key) and every pre-existing create test now runs through a
`fetchWorker` wrapper that plays the owner's exe — file total **53 pass**.

**Tests.** `bridge/test/pairing-routes.test.js` (3 cases) drives real HTTP into
`createApp` with a fake device minted through the real `PairingService.mintDevice()`:
master → `masterUrl` carries `config.mobileToken`; device → **no `masterUrl`/
`masterQr` keys at all** and no field anywhere in the JSON contains the master token,
while the pairing part is intact; no token → 401. `bridge/test/static-headers.test.js`
(3 cases) asserts the exact directive set on the app shell, on an asset and on the SPA
fallback (the shell's `no-cache` and the asset's `max-age=3600` must survive), and
**parses the worker's CSP array and `_headers` to prove all three copies match** —
change the CSP in one place and that test names the other two you forgot.
The two worker changes are covered too, in `worker/test/relay.test.mjs` (mocked
KV/fetch, never a real machine) — **7 new cases**, taking the file from 11 to **18**:
the 11th `/api/pair` from one IP in a minute → 429 `rate_limited` while a second IP
still gets through, and a roomless `/api/pair` → still `400 tenant_required` without
burning a rate-limit token; `ALLOW_ROOM_CREATE="0"` → 403 `room_create_disabled`
with **zero KV reads** (the gate is before the body, so a blind flood never touches
storage); unset and `"1"` → still `200 created` and the secret really lands in KV;
a fake KV that simulates the hijack → 409 `taken` and no `created`; the
read-after-write returning `null` → still `200 created`, i.e. the new check cannot
cry "taken" on a room it merely failed to read; and a static request relayed through
the worker's `withSecurityHeaders` → carries CSP + `nosniff` + `no-referrer`.

Re-ran for this update, from the repo root, all three files green:
`node --test bridge/test/pairing-routes.test.js` → 3 pass / 0 fail;
`node --test bridge/test/static-headers.test.js` → 3 pass / 0 fail;
`node --test worker/test/relay.test.mjs` → 18 pass / 0 fail.
(Per-file invocation on purpose — `node --test <dir>` misbehaves on this machine. The
full bridge/web suites and `vite build` were **not** re-run in this pass.)

> ✅ **Deployed 2026-10-05.** Web bundle rebuilt first (`npm --prefix web run build` →
> `web/dist/_headers` carries CSP + `nosniff` + `no-referrer`), then
> `cd worker && npx wrangler deploy` (version `92321f13`), then one bridge restart.
> Curl verified on both doors: worker URL and tunnel URL answer with the three
> headers; a device-key `/api/pairing-code` call returns no `masterUrl`. The
> restart minted a **new tunnel URL**, so phones re-linked from a fresh QR.
> The earlier staleness warning about `web/dist/_headers` is resolved.

> **Commit state: the 04/10 four are all committed** — `8020ef1` (FIX-1),
> `de7380a` (FIX-2), `72e2288` (FIX-3 + FIX-4), `561aec0` (docs). The 05/10
> remaining-risk closure pass below rides in its own commits.

## Remaining-risk closure pass — 2026-10-05 (workflow run, 8 parallel patches)

The 04/10 audit's accepted-risks list plus its small debts, closed in one
parallel pass (8 agents, file-partitioned; test-repair loop; 6 mutation checks;
3 independent reviewers × 2 rounds). Symptom → where to fix:

| Symptom / risk | Where it was fixed |
|---|---|
| Token rides the URL (`?_t=` on GET) → history, proxy logs, Referer | `bridge/src/auth.js` — `requestToken` reads the Bearer header only; test `bridge/test/auth-query-token.test.js`, expectations in `routes.test.js` / `bridge.test.js` rewritten |
| cloudflared downloaded from `releases/latest`, never verified | `bridge/src/tunnel.js` — pinned `2026.9.3` + `CLOUDFLARED_SHA256` (from the GitHub asset digest), verify before write **and** on every start of the cached file; env overrides `CLOUDFLARED_URL` / `CLOUDFLARED_SHA256`; test `bridge/test/tunnel-integrity.test.js` |
| Room password sits in KV as plaintext | `worker/src/index.js` — records store `secretHash` (sha256, timing-safe compare); legacy `{secret}` records sign in and auto-upgrade on first success; `SECRET-1` tests prove no plaintext lands in KV |
| Rate limit keyed by public IP only → NAT households share 10/min | `worker/src/index.js` `rateLimited(..., scope, ipLimit)` — per-room buckets, plus a raw per-IP ceiling (30/min on `pair-tenant`) so invented room names cannot drain the shared KV quota; `LIMIT-1` tests |
| `ALLOW_ROOM_CREATE` only honours the exact string `"0"` | `worker/src/index.js` `roomCreateDisabled()` — `"0"/"false"/"no"/"off"` any case, numeric `0`, trimmed |
| GUI provisioning shows raw .NET text on 403/409/429 | `desktop/src/OpenPocket.cs` — reads status + JSON `code` (`ReadHttpError`), maps to sentences that carry the fix, auto-retries a fresh random room name on `409 taken` (max 3); gated by `desktop/build.bat` compile |
| Master token printable into `bridge-task.log` | new `bridge/src/log-safe.js` (`redactUrl`, `redactSecrets`) applied to every URL/error the bridge prints in `bridge/src/index.js`; text URLs are masked, QRs kept scannable; test `bridge/test/log-redaction.test.js` |
| `config.json` plaintext + permissive ACL | `bridge/src/config.js` `hardenConfigFile()` — chmod 600 off-Windows, `icacls` strips inherited ACLs on Windows (best-effort, never fatal); test `bridge/test/config-secrets.test.js`. Plaintext stays by design (the C# GUI reads the file directly); since 06/10 the bridge is the only WRITER — GUI saves go through `POST /api/config/identity` (master-only, 4-key whitelist; test `bridge/test/config-routes.test.js`) with a direct-write fallback when the bridge is down |
| Bridge restart minted a new owner token → OpenWork restart loop | `bridge/src/bootstrap.js` — a held raw token is re-inserted into `tokens.json`, never re-minted; only a lost raw token mints; test `bridge/test/bootstrap-owner-token.test.js` |
| Installed PWA keeps a pre-`?_t=`-removal bundle | `web/public/sw.js` — cache `owm-shell-v54` → `v55` |

Six guards were **mutation-verified**: the guard was deliberately removed, the
matching test went red, and the file was restored byte-identical (diff-checked).

Test floor after the pass: bridge **86 → 111**, worker **18 → 48**, web **460 → 432**
(the −28 is the parallel session's `session-organize` removal, not this pass).
Committed but **not deployed**: one web rebuild + one `wrangler deploy` + one
bridge restart bring it live. `worker/scripts/tenant.mjs` still writes legacy
plaintext records — the worker upgrades them on first login, so no migration
script is needed.

## Bridge route table split out of `index.js` — 2026-10-04 (bridge only)

`bridge/src/index.js` went 750 → 284 lines. The ~500-line `handleRequest`
if-chain moved to `bridge/src/app.js` as `createApp(deps)`, with the handlers
grouped by concern under `bridge/src/routes/` and matched by the small
`src/router.js`. The point was not line count: `index.js` exported **nothing**,
so none of the 13 existing test files could reach `handleRequest` — the routing
table, the auth gate and every status code were untested. A mistyped `/api/...`
path stayed green until runtime.

Pure, dependency-free pieces moved out too: `src/rate-limit.js` (sliding-window
per-IP limiter + sweep) and `src/http-util.js` (`readJsonBody`/`sendJson`,
replacing ~25 hand-repeated `writeHead + JSON.stringify` pairs).
`src/openwork-state.js` now owns `openworkStateInfo()` on its own.

**What did NOT change:** every route, status code and message. Verified by a
throwaway script that extracted all 57 human-readable string literals from the
old `index.js` and asserted each one still exists somewhere in `bridge/src` —
one drifted (a single character in the EADDRINUSE warning) and was restored
verbatim from `git show HEAD`. The auth-gate ORDER is preserved exactly:
`/api/pair` and `/api/pair/tenant` still run before the gate, and an unknown
`/api/` path still answers **401 without a token** — 404 `not_found` only once
you hold one.

**New test file `bridge/test/routes.test.js` — 23 cases** (bridge suite 57 → 80,
all green). It drives `createApp` over real HTTP with fake deps: no bridge
process, no config on the machine, no tunnel. `test/startup.test.js` still boots
a REAL isolated bridge process and asserts the same `/api/state` and
`/api/pairing-code` behaviour end to end, and still passes.

> ⚠️ Trap hit while writing that test, worth remembering: `PairingService` and
> `saveConfig` write to `bridgeDataDir()`. The first version of the test did not
> set `OPENWORK_BRIDGE_DIR`, so it minted devices into the **real**
> `%APPDATA%\openwork-bridge\devices.json` and one test even called `revoke()`
> on it. `withApp()` now points `OPENWORK_BRIDGE_DIR` at a temp dir per test and
> restores it afterwards, matching `test/pairing.test.js`. Same class of bug as
> the CLI sandbox one. The real store was verified intact afterwards.

> Last updated: 2026-10-05 — **pin / archive / groups removed** from the web app on the owner's call
> (see the 2026-10-05 section). Parity rounds closed 2026-10-04: session extras (cost, rename,
> /compact, steer, effort/variant, cross-session search, share) and Settings maintenance
> (pairing-code display, machine rename, tunnel restart, engine reload) — see the 2026-10-04 section.
> Also since 2026-10-03: chat streams through a fetch-based SSE client (`web/src/lib/sse.js`:
> Authorization header instead of the old `?_t=` token-on-URL, backoff reconnect 1s→16s, event `type`
> parsed from the JSON body because the engine emits UNNAMED SSE events) and a pure reducer
> (`web/src/lib/chat-stream.js`, unit-tested in `web/test/chat-stream.test.js`) that applies the
> engine's part protocol (`part.updated` snapshots keyed by part id + `part.delta` char deltas,
> flushed per animation frame, longer-of-two wins so bytes are never doubled). Chat's `<select>`
> model picker became a searchable bottom sheet grouped by provider with a Recents list
> (`web/src/components/model-picker.jsx`), and tool calls + reasoning render as ZCode-style
> collapsed one-line rows (`fold-row`: icon, title, status, chevron — slim chrome-less lines inside
> the bubble (no card/border); the body opens indented behind a thin left rule; tap to expand
> input/output, 20k-char display cap). The current product is the core loop only: the bridge (tunnel + lookup
> + pairing + proxy + file services + log wipe), the fixed-address multi-room worker, the phone PWA
> (**Sessions · Workspace · Chat · Files · Settings**), and the OpenPocket desktop GUI + one-file
> installer. The remote-viewing feature set and the bridge OTA self-update are REMOVED (git
> `2a202a3`, `3df494d`); feature history lives in git log and in the dated sections below.
>
> 📌 **Rules (project owner's requirements):** every time code/structure/behavior changes,
> BOTH this file AND `README.md` MUST be updated in the same commit — **in English**.

## Session organizers removed from the phone — 2026-10-05 (web only)

Owner's verdict: the three icon buttons on every session row (pin / assign-group /
archive) were noise for a single-user app — nobody organizes sessions into groups
from a phone. Removed entirely, not hidden:

- `web/src/pages/sessions.jsx`: the All/Pinned/Archived scope chips, the group
  chips, the assign + manage-groups sheets and the three per-row icon buttons are
  gone. A session row keeps title, status dot and time; the only button above the
  list is **Search in workspace**; swipe-to-delete and the (+) FAB stay.
- `web/src/pages/home.jsx`: the pin button, pinned-first ordering and the
  archived filter are gone; the header count no longer shows "N pinned".
- Deleted `web/src/lib/session-organize.js` and its test (28 cases — no other
  caller was left). Stale `pinned`/`archived` flags sitting in a device's
  localStorage are simply ignored now.
- Server side cleaned the same day: `bridge/src/proxy.js` drops `session-groups`
  from the proxy whitelist (the engine keeps the endpoint; the bridge just stops
  forwarding it to phones) and the whitelist test now asserts the path is
  denied. The proxy/auth/startup test files are green (45 tests). No bridge
  restart was spent — it picks the change up on the next one.

Web suite all green (340 tests). Verified in the browser on the built bundle:
plain session rows, chat page unaffected.

## Chat composer floated mid-screen on short sessions — 2026-10-04 (web only)

Symptom: a session with a single message put the input box just under that message,
roughly halfway down the phone screen, with ~458px of dead space below it and nothing
at the bottom.

Cause: `.composer` relied on `position: sticky; bottom: 0` alone. Sticky only pins an
element when the page is **taller than the viewport**. A short session is not scrollable,
so the composer stayed at its normal-flow position — right after the transcript — and the
unused space fell below it. The layout was correct only for long sessions, which is why it
survived the earlier QA rounds: every one of them tested a transcript long enough to scroll.

Fix: `.view.chat-view` is now a flex column and `.chat-list` gets `flex: 1`, so the
transcript absorbs the slack and the composer lands at the bottom. Sticky is kept for the
long-session case. Verified in a real browser at 390×844 against a replica of the chat DOM:
gap below the composer **458px → 0px**, and with 12 messages the composer stays flush at
all three scroll positions (top, middle, bottom).

| Symptom | Implementation and regression evidence |
| --- | --- |
| Input box floats mid-screen, huge empty space under it | `styles.css` `.view.chat-view` + `.chat-list { flex: 1 }`; only the chat view opts in, other pages keep block flow. Measured 0px gap at 390×844 |

## Chat markdown: real GFM rendering (tables at last) — 2026-10-04 (web only)

Symptom: every markdown table in an assistant reply showed up as raw text rows with `|`
characters glued together, and `**bold**`, `## headings` and links printed their markers.
Cause: `MarkdownText` in `chat.jsx` had **no markdown parser at all** — it split the text on
```` ``` ```` and then rendered every remaining line as its own `<span>` + `<br>`. A GFM table is
a *block* construct (`| a | b |` plus the `| --- | --- |` delimiter row), so splitting per line can
never produce a `<table>` element for CSS to style. OpenWork desktop renders the same content with
`marked` + `gfm: true` (`apps/app/src/components/markdown/markdown-primitive.ts`, its `table`
renderer), which is where the parity gap came from.

Fix — new pure module `web/src/lib/markdown.js` (unit-tested in `web/test/markdown.test.js`),
wired in `chat.jsx`'s `MarkdownText`, styles in `styles.css`:

- Same engine as the desktop: `marked` with `gfm: true`, so tables, `**bold**`, `_italic_`,
  `~~del~~`, headings, links, blockquotes, ordered/unordered lists and fenced code all render.
- **Column alignment survives**: the `---:` / `:---:` delimiter becomes
  `style="text-align:right"`, so numeric columns line up like they do on the desktop.
- `.md-table-wrap` scrolls horizontally instead of squeezing columns — without it a wide table on
  a 390px phone collapses to one character per cell.
- **Security without a new dependency**: raw HTML in markdown is *escaped* (desktop passes it
  through), and every href goes through `safeHref` (`http`/`https`/`mailto` + relative only), so
  `javascript:` and `data:` become `#` and `DOMPurify` is not needed. Covered by tests.
- Internal file paths still become clickable Open/Download links — `fileHref` is injected by the
  caller, keeping the module free of Preact, tokens and `localStorage`.
- `createMarkdownStream()` reuses the HTML of finished top-level blocks and only re-renders the
  last two (a growing block can reshape the one before it — a table's `---` row only becomes a
  table once data rows follow). The chat flushes per `requestAnimationFrame`, so re-parsing the
  whole message each frame was O(n²).

Desktop-only for now: `.xlsx` still opens as a plain download here, while the desktop opens it in a
sheet artifact editor (`isSheetPreviewSupported` covers `csv`/`tsv`/`xlsx`) — decided as acceptable:
on a phone, downloading the sheet to view it in the real spreadsheet app beats an editor embedded in
a web view. CSV/TSV in the Files viewer still open in a `<textarea>`. Math/KaTeX is likewise absent —
`$O(n \log n)$` shows as raw text. That gap is deliberate for now (a KaTeX bundle is a real weight
decision on mobile), not an oversight.

### QA round on the markdown renderer (4 independent review agents)

Four reviewers attacked it from different angles (security, desktop parity, Preact runtime, mobile
UI). Every fix below was **reproduced locally before being fixed**, not taken on trust.

| Severity | Bug | Fix |
| --- | --- | --- |
| CRITICAL | `AT&amp;T` rendered as `AT&amp;amp;T` — `escapeHtml` escaped `&` unconditionally | `escapeText()` mirroring marked's internal escape, keeping valid entities. Code spans keep the full escape (GFM treats entities in code as literal) |
| CRITICAL | Every bare URL in prose produced **nested `<a>`** — the Windows path regex matched the `s:/` inside `https://`, and `renderer.text` also ran inside link labels | Link labels render through `parser.textRenderer`; negative lookbehind so a scheme letter can't start a drive path |
| HIGH | `- [ ] todo` lost its checkbox entirely — marked v15 keeps task state on the item instead of emitting a `checkbox` token, so the overridden `listitem` dropped it | Insert the checkbox in `listitem` |
| HIGH | A reference-style link **never appeared, even after streaming finished**: the first block rendered before its `[ref]:` definition existed, and the cache kept that HTML because `raw` was unchanged | `REFERENCE_DEF` guard. Note marked v15 **swallows** `def` tokens (v17 emits them), so desktop's `tokens.some(t => t.type === "def")` cannot be copied — and any definition present now forces a full re-render, not just a re-lex |
| HIGH | `.md-table-wrap` lost its horizontal scroll position on **every frame** while a table was streaming, because assigning `innerHTML` destroys and recreates all child nodes | Snapshot `scrollLeft` during render (the `getSnapshotBeforeUpdate` equivalent Preact lacks) and restore in `useLayoutEffect`. Verified in a real browser: node identity changes, scroll survives |
| HIGH | `collectFileRefs` rescanned every message each frame — **7.4 ms/frame at 200 messages**, ~8× the whole markdown cost | `useMemo` on `[role, parts]` |
| MEDIUM | `~single~` became `<del>` | Desktop's single-tilde guard copied verbatim |
| MEDIUM | Streaming a 56 KB message cost **754 ms** total, because `marked.lexer` re-lexed the whole text each frame (it is ~90% of render cost, so caching HTML alone barely helped) | Lex only the appended tail: **754 ms → 48 ms**, byte-identical output |
| MEDIUM | User messages ran the lexer and threw the result away | `MessageBubble` renders plain text directly for `role === "user"` |
| **CRITICAL** | **`escapeText` regex had no `g` flag**, so `String.replace` swapped only the FIRST match. Any reply with two tags left the second live: `<p>x</p><img src=x onerror=…>` was a working script sink. My own test passed because the sample happened to need exactly one replacement | Added `g` |
| **CRITICAL** | To stop nested `<a>`, `link()`/`del()` were rendered through marked's `parser.textRenderer` — a token-to-text shortcut that **escapes nothing**. `[<img src=x onerror=…>](https://e.com)` executed | A label-depth flag that skips linkification but keeps escaping. Bonus: `<strong>`/`<code>` inside link labels render again |
| MEDIUM | `safeHref` let `//evil.com` and `/\evil.com` through — the browser rewrites `\` to `/`, so both resolved off-site and leaked the Referer | Normalise backslashes first, then reject protocol-relative |
| MEDIUM | LLM-invented paths could contain `../`; `encodeURIComponent` URL-encodes but does not stop traversal | `normalizeFilePath` rejects `..` segments and control chars. **Defence in depth only — the engine must still resolve and confine the path itself** |
| LOW | `//host/path` was mistaken for a workspace file | Treated as external |
| LOW | `fileHref` output skipped `safeHref` | Normalised at a single choke point |

The two CRITICALs were both *introduced by the fixes in the row above them* — worth
remembering that "this function is on the escaping path" is not evidence that it escapes.

### Mobile UI review

Measured, not eyeballed: table overflow, `word-break`, `nowrap`, `max-width: 86%`,
`prefers-reduced-motion` and `prefers-color-scheme` all checked out. Note the app has
**no dark mode by design** (`color-scheme: light`, owner's decision) — the reviewer had
to inject dark tokens to test, and every rule passed 100% on tokens with no hardcoded
colours.

- `.md-table-wrap` gained `overscroll-behavior-x: contain`. Without it a horizontal
  swipe at the edge can be claimed by the browser and become a swipe-back that leaves
  the PWA. **Only the `-x` axis** — the `contain` shorthand would eat vertical chat
  scrolling.
- Added a pure-CSS scroll shadow (two `local` gradients that travel with the content +
  two `scroll` radials pinned to the edges), so the right edge only shows when columns
  are actually hidden. A table clipped at the bubble edge gave no hint it could be
  swiped.
- `blockquote` was `--text-faint` = **3.30:1** on white, under the 4.5:1 that this very
  file sets as its own rule for `.banner.warn`. Now `--text-dim` at 5.93:1.
- `h4/h5/h6` were all the same size, and `h6` came out *smaller* than body text. Now a
  real scale.
- Alignment is selected by `.md-align-*` class, not `[style*="right"]`, which would die
  silently if the renderer changed how it writes the attribute.

**Do not add `overflow-wrap: anywhere` to table cells.** It lowers min-content to one
character, so the browser squeezes text columns to zero width — a "Tháng" header renders
as `T h à n g`. `overflow-wrap: break-word` does nothing at all. A long token making a
column wider is the correct trade: the table already scrolls, and it still cannot
overflow the bubble.

### A layout bug only a screenshot caught

`.md-table { width: 100% }` forced the table into the bubble's width, squeezing the
last column to ~60px so ordinary text wrapped to three lines and every row measured
**65px**. Changed to `width: max-content; min-width: 100%` — narrow tables still fill
the bubble, wide ones scroll without squeezing. Rows are now **29px**. No unit test
would have found this; it came from measuring a rendered page.

### Confirmed sound, so nobody re-investigates

No hook-order violation; no cross-session cache leak; Preact compares the `__html`
*string*, so a new object per render does not force a rewrite; `reset()` is never
called but memory stays bounded per message (28–158× the text, not a leak); no regex
`lastIndex` bugs; `safeHref` neutralises `javascript:`/`data:`/`vbscript:`/`file:`; the
two-pass `linkifyPaths` cannot be abused even though the second pass runs over the
first pass's output (80k fuzz cases, zero live tags).

### Known upstream limitation, deliberately not patched

`marked` is O(n²) on long runs of repeated punctuation: 50k `!` costs ~1.9s for a single
parse, and ~640ms **per frame** while streaming. Marked v17 was benchmarked and has the
same curve, so upgrading is not a fix. The prefix-tail lexing does not help either — a
single 50k-character block has no block boundary to cache against. A realistic 56KB
message streams in 48ms total, so the practical impact is nil; reaching it needs
deliberately crafted content, and every available "fix" truncates legitimate messages.
Tracked rather than papered over.

Two of my own test assertions were also wrong: one rejected cells that legally contain `|` (escaped
pipes), and one was near-vacuous. Both rewritten as structural assertions.

Confirmed **not** broken, so nobody re-investigates: no hook-order violation, no cross-session cache
leak, Preact compares the `__html` *string* so a new object does not force a rewrite, `reset()` is
never called (memory is bounded per message, not a leak), no regex `lastIndex` bugs, `safeHref`
neutralises `javascript:`/`data:`, and the Files/`.xlsx` behaviour above is a known gap rather than a
regression.

## Chat: always open at the newest message + a "jump to latest" button — 2026-10-04 (web only)

Symptom: opening a long session showed the **oldest** message, and scrolling up through history
left no way back to the live tail. Cause: `chat.jsx` only auto-scrolled when
`scrollHeight - innerHeight - scrollY <= 260`, and it measured that **after** the new transcript had
rendered — with `scrollY` still 0 and a tall document the gap was thousands of pixels, so the
scroll was skipped every time. The same late measurement also killed auto-follow whenever a single
streamed text/tool block grew taller than 260 px (the view would silently stop mid-screen).

Fix — pure logic in the new `web/src/lib/chat-scroll.js` (unit-tested in
`web/test/chat-scroll.test.js`), DOM wiring in `chat.jsx`, styles in `styles.css`:

- `scrollPlan({forced, atBottom}) → "instant" | "smooth" | "hold"`. `forced` (transcript thật đầu
  tiên của phiên) always wins, so **entering a session always lands on the newest message**,
  instantly rather than smooth-scrolling through thousands of pixels.
- "At bottom" is tracked by a passive `scroll` listener (rAF-throttled, state only set on a flag
  flip), i.e. the user's real position measured **before** the next render.
- `keepsAutoScroll()` / `leftBottomBy()` decide two things the listener cannot infer on its own:
  whether the app itself is mid-scroll (see the QA round below), and whether a swipe up means "let
  me read history" — which leaves the follow band **immediately**, not after 260 px.
- New **"jump to latest" pill** (`.jump-latest`, ≥44px, `--shadow-float`, reduced-motion honoured):
  it appears whenever the reader is up in history, reads "Tin mới nhất" or "N tin mới", and is
  anchored `position: absolute` to `.composer` (already `sticky`, hence a containing block) at
  `bottom: calc(100% + var(--sp-3))` so it sits fully outside the composer without measuring its
  variable height. It is the composer's **last** DOM child on purpose: as the first child, Preact's
  index-based child matching remounted the whole `flex:1` subtree every time the pill appeared or
  disappeared — blowing away textarea focus and any in-flight Vietnamese IME composition.
- `newMessagesSince()` anchors on the rightmost already-seen id, so a streamed part update or an
  optimistic `local-…` message being replaced by its real `msg_…` never inflates the count.
- Navigating chat→chat (e.g. after `fork`) clears the transcript via `commitMessages(null)` on
  session change, so the previous session's messages can't flash before the new fetch lands.
- `settleToBottom()` re-pins for up to ~0.7 s after a load/jump, because content can still grow
  (streaming, opened folds, images). It's cancelled on unmount so it can't scroll another page.

### QA round (3 independent reviewers) — what the first pass got wrong

The first implementation passed its own tests and was still broken in two ways, both found
independently by two reviewers:

1. **Auto-follow died mid-message anyway.** `autoScrollRef` was set only inside `settleToBottom()`,
   which runs on the session-open path. The streaming path (`scrollPlan → "smooth"`) scrolled
   without the flag, so `measure()` read the app's own in-flight smooth scroll as "the user scrolled
   up", flipped the flag, and the next flush fell into `"hold"` — the exact bug this change was meant
   to fix, plus a spurious "jump to latest" button. Now the flag is set before **every**
   programmatic scroll, and released by `keepsAutoScroll()` when it lands or when the reader
   actually pulls up.
2. **A stale fetch could install the wrong session's transcript.** `ChatPage` is rendered unkeyed, so
   `forkFrom`'s `navigate()` left `run()` reloading with the previous session's closure; that
   response could land last and both overwrite the new transcript and burn the "always land at the
   bottom" flag. Every loader (`loadSession`, `loadMessages`, `loadStatus`, `loadTodo`,
   `loadPermissions`) plus `run()` and `send()`'s optimistic append now capture the session id and
   bail if it changed while in flight.
3. Also fixed from that round: `forced` could be consumed by an SSE stub before the real transcript
   arrived (now gated on `transcriptRef`), the pill's offset sign put it 8 px *inside* the composer
   (`100% - 8px` → `100% + 12px`), and hardcoded `gap: 5px` / `padding: 0 14px` became spacing
   tokens.

Verified 2026-10-04: `node --test web/test/*.test.js` → **309 pass / 0 fail**; `vite build` → OK
(JS 190.64 kB → 62.29 kB gzipped, CSS 26.72 kB → 5.81 kB gzipped). Committed, **not deployed** to the
worker.

Known trade-off: the pill floats over the transcript (ChatGPT/ZCode pattern) with no reserved
gutter, so it can cover the bottom-right corner of the newest right-aligned user bubble and swallow
the tap that opens that message's action sheet. Fixable with one line of `.chat-list` bottom padding
or by shrinking it to a 44 px round button.

## Parity rounds closed — 2026-10-04 (web only, working tree)

Two rounds bring the phone app level with the OpenWork desktop app (source-of-truth:
`github.com/different-ai/openwork`, branch `dev`), all through the existing proxy whitelist — zero
bridge/worker changes.

**Round 1 (session features, 8 items).** Per-session **cost** display, **rename**, **/compact**
(summarize), **effort/variant** fields in prompt bodies, **steer** (send while the agent runs),
**cross-session search** (name + content), **pin/archive/groups**, **share link**. Implementation is
file-partitioned pure libs (`web/src/lib/session-*.js`) + wiring in `chat.jsx` / `sessions.jsx` /
`home.jsx` / `model-picker.jsx`. Regression-hardened in the same pass: `shouldClearRevertCursor`
(edit+send no longer hides the new message behind the revert cursor), `mergeRefetchKeepInflight` drops
`local-*` optimistic messages once the server transcript confirms them (no duplicates),
`deleteMessage` routes through `commitMessages` (refs stay honest), the agent picker validates the
stored agent against the live list, `parseModelValue` reuse keeps mid-slash model ids intact
(`openrouter/anthropic/…`). UI pass: ≥44px touch targets, banner contrast recomputed (WCAG ≥4.5:1 via
`color-mix`), dedicated safe-area rule for the search screen.

**Round 2 (machine maintenance in Settings).** Four existing routes the web never called:
- `GET /api/pairing-code` → **"Ghép thiết bị khác"** card: the live one-time code (`codeFormatted`
  XXXX-XXXX + mm:ss countdown from the new pure lib `web/src/lib/pairing-code.js`) and a copyable
  invite link for the new device's login screen. The response's `masterUrl`/`masterQr` are
  deliberately NOT rendered — the permanent master token stays terminal/GUI-only; only the
  self-neutralizing one-time code appears on the phone. Countdown math is lib-tested
  (`web/test/pairing-code.test.js`).
- `POST /api/tunnel/restart` → **"Khởi động lại tunnel"** (replaces cloudflared, keeps the bridge —
  no 429-counter impact; 409 `tunnel_inactive` surfaces the bridge's Vietnamese message verbatim).
- `POST /api/machine/name` → inline **machine rename** (client-side empty guard; bridge strips
  quotes/newlines and caps at 60 chars) — the next paired device sees the new name.
- `POST /workspace/:id/engine/reload` → **"Nạp lại engine"** inside *Chi tiết kỹ thuật* —
  `owEngineReloadAll` reloads every workspace sequentially and never fails the whole batch; desktop
  parity for its Settings action (minus the restart-desktop fallback → web hints at "Mở OpenWork").

**Pairing-code security (checked before building — user asked "8 số thì dính lỗi chứ?").** The code is
not 8 decimal digits: it is **8 chars from a 32-char unambiguous alphabet (no 0/O/1/I) = 32⁸ ≈
1.1×10¹² (40 bits)**, one-time, 30-min TTL, timing-safe compare, and `POST /api/pair` is capped at
10 attempts/min/IP (`pairRateLimited`); through the tunnel every request shares one loopback bucket,
so the practical ceiling is even lower. Brute force is dead on arrival — no change needed.

New tests: `web/test/pairing-code.test.js`, `web/test/api-machine.test.js`. Verified 2026-10-04:
`node --test web/test/*.test.js` → **249 pass / 0 fail**; `node --test bridge/test/*.test.js` →
**53 pass / 0 fail**; `vite build` → OK (JS 143.08 kB → 46.65 kB gzipped, CSS 23.68 kB → 5.23 kB
gzipped). Working tree only — **not committed yet**.

## This maintenance round — 2026-10-03 (session parity: what one session was missing)

**The question:** "an OpenWork session has all these features — why are we missing them, can we do the whole thing on one session?"
**The answer, and what was built.** The OpenWork desktop app is open source (`github.com/different-ai/openwork`,
branch `dev`), so the reference is the real source, not guesswork — `apps/app/src/components/chat/message-list.tsx`
(message menu), `.../domains/session/surface/composer/` (slash commands, @-mentions, agent picker),
`.../sync/transcript-reconcile.ts` (the revert + fork rules). Before writing anything, `GET /workspace/:id/opencode/doc`
(the engine's own OpenAPI, 162 paths) was read live and the risky routes were exercised on a throwaway session created
with `noReply: true` prompts, then deleted. **Every route used here already existed on engine v1 and already passes
`bridge/src/proxy.js`'s whitelist — no backend change was needed** (the earlier guess that fork/revert needed a new
`/opencode2` proxy entry was wrong; v1 serves them under `/opencode`).

Added to ONE session (the chat screen), verified in a real browser against the running engine:

1. **Tap any message → action sheet**: Copy · Edit & resend · Branch into a new chat · Undo from here · Delete.
2. **Undo / redo**: `session.revert.messageID` is a cursor; the transcript endpoint still returns every message, so
   `applyRevertCursor` cuts client-side and a "N tin nhắn phía sau đang ẩn · Hiện lại" bar offers the way back.
3. **Edit & resend** reverts to the edited message *before* prompting — otherwise the old turn survives and the new one
   is appended after it.
4. **Branch into a new chat** — `resolveForkBoundaryId` passes the **next** message id because the engine copies
   messages *strictly before* the given one.
5. **Agent picker** (`GET /agent`) next to the model pill; the chosen agent rides the prompt body.
6. **Slash commands** — type `/` for the real command + skill list, tap to run (`POST /session/:id/command`).
7. **Agent questions** (`GET /question`) — this was the worst gap: the agent could ask something and the phone showed
   nothing, so the run just sat there. Now a card with multi-select options, an optional free-text answer, and a
   "Bỏ qua" (reject) path.
8. **Todo progress** row (`GET /session/:id/todo`): "3/7 · <task in progress>".
9. **Tool rows read like the desktop**: Vietnamese label + a one-line title from the tool's own input
   (`toolRowView`) instead of a wall of raw JSON; `metadata.preview` is used when `output` is empty.
10. **Bug fixed on the way**: every prompt used to start with a stray newline (`fileBlock + "\n" + text`, even with no
    files attached).

`web/src/lib/session-ops.js` holds all the pure logic (revert cursor, fork boundary, question shaping, tool view-model)
with 15 regression tests in `web/test/session-ops.test.js`; suite is 112 passing.

**Left out, on purpose** (desktop-only or absent upstream): terminal dock, browser panel, file-tree rail, effort/Fast-mode
profiles, per-session share link, drag-to-reorder, and voice input (OpenWork has no voice input either).

---

## Earlier maintenance round — 2026-10-03 (commits + working tree)

What this round changed, in order:

1. **Bridge OTA self-update removed** (`3df494d`, finished in the working tree): the updater module,
   the rollback watchdog script, the release publisher, the worker's KV release routes and the
   `bridge/VERSION` file are gone (`bridge/package.json` is the single version source now — see the
   comment at `bridge/src/index.js:21`; `desktop/build-setup.js` no longer copies a VERSION file).
   Distributing an update = shipping a fresh `OpenPocket-Setup.exe`.
2. **10 bridge durability fixes** (`1d96865`) + new static/auth tests: the listener retry loop
   shares one counter with a ten-retry cap (`bridge/test/listener.test.js`), background stdout no
   longer prints pairing codes / QR payloads / the master token (`bridge/test/startup.test.js`
   boots a real isolated process and asserts the output is credential-free), the worker refuses
   roomless bootstrap calls instead of fanning a stranger's code/key out to every live machine,
   and `web/public/_headers` mirrors the worker CSP for the asset-first path.
3. **Web API cleanup + first real unit tests** (`efe2a5f`, extended in the working tree) — see the
   section below; `web/test/` now holds 25 real tests.
4. **Desktop GUI hardening** (`e5e4571`): `SafeInvoke` marshalling guard, `WaitForExit` timeouts on
   every `schtasks` call, WMI kill pinned to the bridge's full entry-script path, `/run` exit-code
   handling, provisioning failures surfaced in red with a retry — see its section below.
5. **Installer vendoring** (`616238c`): `desktop/build-setup.js` walks the production dependency
   closure from `bridge/package-lock.json` (exactly one package — `qrcode-terminal@0.12.0`) into the
   installer package, demotes the Node check to a non-blocking warning and asserts `web/dist`
   freshness before staging — see the Installer section.
6. **Web UI state-honesty + dead-code sweep** (`fe3830f`): `settings.jsx` recheck failures surfaced,
   the app banner prints the real network error, `FileViewer` blob-URL leak fixed, `FilesPage` race
   guard, chat queue model staleness + visible retry status, PWA cache bumped to `owm-shell-v48`,
   ~475 lines of viewer CSS + the keychain-card CSS deleted (zero JSX references), 9 unused icons
   removed, minimum a11y (roles, focus, one `aria-live` status line instead of the whole transcript).
7. **Review fixes (working tree, this pass)**: `pairing.jsx` + `api.js` — the bare-key row now
   detects the worker's 400 `tenant_required` (`apiPair` copies `payload.code`/`status` onto the
   thrown error; 3 new contract tests) and gained a **Phòng (room) box** that backfills the tenant
   for a bare key (a full `#t=…&m=…` link still wins). `worker/src/index.js` — the `tenant_required`
   message no longer points at the removed sign-in UI; it names the paths that still exist (rescan
   the QR / re-open the full link / type the room). `bridge/src/config.js` + `bridge/src/index.js` —
   the QR base-URL choice moved into the pure, unit-tested `pairingBaseUrl()`: the worker address
   only wins when `lookupTenant` is set (whitespace-only counts as empty), else tunnel → `publicUrl`
   → localhost; the `lookupTenant` comment no longer advertises the removed `edge join` flow.
8. **Docs**: this file and README.md rewritten to match the tree above — the remote-viewing feature
   set, the removed native dependency stacks and the removed OTA system are no longer described as
   if they exist (rows for deleted files are deleted, not reworded).

Verified on 2026-10-03 with `OPENWORK_BRIDGE_DIR`/`OPENWORK_DIR` pointed at temp dirs (no real
`%APPDATA%\openwork-bridge` touched): `node --test bridge/test/*.test.js` → **50 pass / 0 fail**;
`node --test web/test/*.test.js` → **44 pass / 0 fail**; `node --test worker/test/*.test.mjs` →
**11 pass / 0 fail**; `node web/node_modules/vite/bin/vite.js build web` → OK (last build: JS 85.48 kB →
28.84 kB gzipped, CSS 20.20 kB → 4.68 kB gzipped).

## Chat scroll-jump fix — 2026-10-03 (web only)

Symptom: while the agent was running, scrolling down (or reading anywhere near the bottom) got
yanked back up. Cause: any full-transcript refetch DURING a run — SSE reconnect (`onOpen` →
`flushQueue`), `onLost`, tab-visible/focus refetch, the 30 s watchdog — replaced the message list
with the API transcript, and that API only flushes a message when the run finishes, so the
in-flight assistant message vanished; the document collapsed by thousands of pixels and the
browser clamped `scrollY` upward (the auto-scroll then pinned the rebuilt message again — a
violent bounce). Fix: `mergeRefetchKeepInflight(fetched, prev)` in `web/src/lib/chat-stream.js`
(used by `loadMessages` only while `running`) re-appends local messages the fetched transcript
lacks; refetches after the run ends replace cleanly as before. 3 new tests
(`web/test/chat-stream.test.js` → 10 pass); `web test` suite and `vite build` verified 2026-10-03.

## Web API cleanup + first real unit tests — 2026-10-03

`web/src/api.js` dropped the exports orphaned by the feature removals (grep-verified zero
importers across the repo): `listKeys`, `renameKey`, `ensureActiveKeyEntry`, `inviteFromHash`,
`apiPairTenant`, `apiMachineStatus`, `apiRevokeMachineKey`. `fileToBase64` and `MAX_UPLOAD_BYTES`
stay but are module-internal now (only `owUploadFile` uses them). `filenameFromDisposition` gained
an `export` — a pure helper — so the content-disposition rules are testable directly.

The keyring migration IIFE no longer runs at import time: it is now an exported, idempotent
`migrateKeys()` invoked lazily on the first `loadKeys()` read, so importing `api.js` in bare Node
(no `localStorage`) has zero side effects — that is what makes the module unit-testable. App
behavior is unchanged: every keyring read/write still promotes the legacy single token into
`owm_keys` on first touch, and nothing outside these functions reads `owm_keys`.

`web/test/` (previously empty — `npm --prefix web test` was green with 0 tests) now holds two real
suites; they shim `localStorage`/`location`/`fetch` and point `OPENWORK_BRIDGE_DIR`/`OPENWORK_DIR`
at temp dirs, so no real bridge is ever touched:
- `api-keyring.test.js` (10 tests): addKey entry/replace-same-tenant/append; removeKey promoting
  `keys[0]` to active, leaving non-active removals alone, and clearing `owm_token`/`owm_tenant` when
  the bundle empties; migrateKeys writing exactly one entry, staying idempotent, and keeping a
  pre-existing `owm_keys`; plus an import-probe asserting zero storage reads at import time.
- `api-contract.test.js`: `ow()` 401 → `Error("UNPAIRED")` (the string app.jsx matches),
  non-OK → `error.status` + `payload.message` with `HTTP <status>` fallback, 204 → `null`, success
  JSON passthrough, auth/tenant/JSON-body request headers; `blobUrlFor()` fetching by header with
  NO token on the URL (asserted), empty input short-circuit, engine error message propagation, and
  `removeKey()` clearing the blob cache; `filenameFromDisposition()` preferring `filename*` UTF-8,
  falling back to the raw value on broken percent-encoding, plain/missing header handling;
  `apiPair` copying the machine-readable error `code`/`status` onto the thrown error (the
  `tenant_required` detection). The old `sseUrl()` `_t`/`_m` cases were replaced when `sseUrl()`
  was deleted.

Verified: `cmd /c npm --prefix web test` → 25 pass / 0 fail; `npm --prefix web run build` → OK.

## Reliability maintenance — 2026-09-18 (local, not deployed)

| Symptom | Implementation and regression evidence |
|---|---|
| Port contention retries forever | `bridge/src/index.js`: counter survives error callbacks; `bridge/test/listener.test.js` checks the ten-retry cap. |
| Background logs disclose pairing credentials | `printPairing` requires a TTY; unconditional master-token banner removed. `bridge/test/startup.test.js` boots a real isolated process, exercises HTTP auth and pairing-code API, and verifies stdout contains neither credential nor code. |
| Manual pairing without a room fails | By design now: the worker refuses roomless `POST /api/pair` / `GET /api/state` with **400 `tenant_required`** — it never fans a stranger's code/key out to other people's machines (message reworded 2026-10-03, see the review-fix item above). `worker/test/relay.test.mjs` uses mocked KV/fetch, not real machines. |
| Asset-first delivery bypasses Worker CSP wrapper | `web/public/_headers`: identical CSP for the static asset service; Vite copies it to `web/dist`. Keep `run_worker_first` selective to avoid adding Worker invocations for static requests. Production header coverage still needs deployment verification. |

Verification commands from repository root: `npm --prefix bridge test`; `node --test worker/test/*.test.mjs`; `npm --prefix web test`; `npm --prefix web run build`. Tests must not invoke installed bridge startup or any publishing step. The startup smoke test overrides both `OPENWORK_BRIDGE_DIR` and `OPENWORK_DIR`, disables the tunnel, and uses a dynamically allocated loopback port.

Broader Chat outbox and file conflict protection remain separate work, not covered by these regression tests.

## Audit tương tác toàn diện — 2026-10-04 (4 vùng, +1.9k dòng, 314 → 440 test)

Bốn agent chia theo vùng file không chồng nhau (chat / vòng đời phiên / Files-Search-Settings /
api-routing-offline), sau đó một agent đối kháng soi lại chính đống vá đó. Dưới đây là phần
**đã kiểm chứng**, không phải phần báo cáo.

### Bug do chính bản vá tạo ra (tôi tự tái hiện được, không tin báo cáo)

| Lỗi | Triệu chứng | Nguyên nhân |
|---|---|---|
| Tin vừa gửi **biến mất** khỏi màn hình | Gõ "ok" (đã hỏi 20 lượt trước) → Gửi → SSE reconnect/tab focus → tin không còn | `mergeRefetchKeepInflight` đếm tin user theo nội dung trong **cả lịch sử** rồi trừ từ đầu, nên tin cũ "tiêu" hết chỗ của tin mới. Chốt đúng: **chỉ tin MỚI xuất hiện trong `fetched` mới xác nhận được tin chờ** (`prevIds` lọc trước), ghép theo thứ tự gửi |
| Nén hội thoại `/compact` và lệnh `/…` bị cắt sau 30s | abort giữa lúc nén, phiên lửng lơ | `ow()` thêm trần 30s chung, nhưng engine **cố ý miễn timeout** cho `/summarize` + `/command` (opencode.ts, `SESSION_LONG_RUNNING_URL_RE → 0`). Hai hàm đó nay `timeoutMs: 0` |
| Nút Dừng kẹt vĩnh viễn | Lượt chạy xong, `step-finish` đã về, UI vẫn "agent đang chạy…" | `sessionBusyFromMap` trả `undefined` khi map rỗng, caller giữ trạng thái cũ. Engine chỉ liệt kê phiên **đang chạy**, nên vắng mặt = rảnh → `false`. `undefined` giờ chỉ dành cho "đọc hỏng" hoặc shape lạ |
| Trần upload nói dối | Báo 40MB nhưng mọi file 5–40MB đều hỏng 413 | `POST /files/raw` kiểm `FILE_SESSION_MAX_FILE_BYTES = 5.000.000`. Trần của web lấy đúng hạn mức engine, không phải trần body của proxy |

### Bug nền tìm được, đã sửa và kiểm chứng

- **Nút "Cho phép" không bao giờ có tác dụng** (nặng nhất trong đợt này): web gửi `{response:"allow"|"deny"}`, engine nhận **`{reply:"once"|"always"|"reject"}`** — engine bỏ qua field lạ nên coi như chưa trả lời, agent treo ở bước xin phép. Nguồn: `opencode-v2-adapter.ts:140` + test `opencode-archive-transport.test.ts:73-85`.
- **Xoá phiên hỏng không bao giờ thấy lỗi**: `remove()` gọi `load()` ngay cả sau `catch`; `load()` thành công thì `setError("")` xoá mất chính dòng báo lỗi.
- **Hash hỏng làm sập cả app**: `decodeURIComponent` trên `location.hash` ném `URIError` — mà `absorbTokenFromHash()` chạy lúc **import module**, tức một QR cắt ngang giết app trước cả khi render. Đưa vào `lib/route.js` với `safeDecode`.
- **`data:` không khoảng trắng bị rơi**: parser cũ lọc `startsWith("data: ")`; chuẩn SSE cho phép không có space và chính engine đọc mọi nơi bằng `startsWith("data:")`. Parser mới theo đúng spec (frame nhiều dòng, CRLF, frame cuối thiếu `\n\n`).
- **`removeKey` để lại tenant cũ** → token và tenant lệch nhau, mọi request đi nhầm máy, 401/503 không tự hồi.
- Tin gửi lộn **hai lần**: bản optimistic được ghép với bản thật bằng `info.time.created` — `Date.now()` của điện thoại so với dấu thời gian máy tính, hai đồng hồ không bao giờ bằng nhau.
- Hàng đợi offline **rò tin sang phiên khác** (bản đồ `sessionId -> tin` thay một hàng đợi chung); bấm hai lần Gửi gửi trùng (khoá bằng ref vì state chỉ đổi ở render kế tiếp); `run()` xoá state của phiên khác; file text >8MB giết tab điện thoại (`textTooLarge`); upload nhiều file chỉ báo lỗi file cuối; `snippetAround` lùi quá tay khi từ khoá dài hơn cửa sổ; `formatTokens(999999)` = "1.000K" (đọc ra là một triệu); bấm "Thu hồi" thiếu `devices` làm sập màn Cài đặt.

### Kiểm chứng thật (không chỉ test)

Chạy app thật trên `vite dev` (proxy `/api` → bridge thật → engine thật), mở phiên `Airwallet` — đúng
phiên đang treo — và gửi tin thật: tin hiện ngay, nút Gửi hoá nút Dừng, dòng trạng thái báo đang chạy,
agent trả lời "PING", transcript về đúng 4 tin **không trùng**, và sau khi sửa `sessionBusyFromMap` thì
dòng trạng thái trống + nút Dừng biến mất. Danh sách phiên, trang Files (kể cả tên thư mục tiếng Việt)
và deep-link `?open=` mở viewer với nội dung thật đều render đúng.

### Cố ý KHÔNG làm

- Không thêm rate-limit, bước xác nhận hay hộp thoại bắt buộc (chủ dự án đã cấm).
- Không chặn xoá phiên đang chạy: desktop cũng không chặn, engine tự abort lượt đang chạy.
- Không validate mã ghép ở client: làm thêm sẽ tạo nguồn chân lý thứ hai, sửa bridge là xoá luôn
  khả năng ghép máy của mọi người.
- ~~`sseUrl` vẫn đặt token trong `?_t=`~~ — **đã xử lý 2026-10-04**: `<img>`/`<iframe>` nay fetch bằng
  header rồi gắn `blob:` (`blobUrlFor`), link file trong markdown trỏ thẳng trang Files của app,
  `sseUrl()` đã bị xoá. Token không còn lọt vào history/referrer của trình duyệt.
- Web chỉ nói được opencode **v1** (`/opencode/*`). Nếu bật `chatRouting` (v2 sidecar) thì đường
  question/permission của v2 khác hẳn; khi đó phải sửa theo, không phải lỗi hiện tại.

### Xác minh hợp đồng API

Đối chiếu từng endpoint web gọi với engine: **14/14 khớp**, kể cả hai hàm từng bị nghi ngờ sai
(`owReplyQuestion`/`owRejectQuestion` — `/question/{id}/reply` với body `{answers}`, không có
sessionID là **đúng** cho v1; nhầm với bản v2 mới có sessionID trong path).

## Tin nhắn gửi đi không ai trả lời — 2026-10-04 (web: model nhớ bị engine đổi tên)

**Triệu chứng**: gửi tin trên điện thoại, tin được lưu vào transcript nhưng agent không chạy — không
trả lời, không lỗi, không báo gì. Người dùng gửi lại lần hai, y hệt.

**Chuỗi tìm ra** (không phải lỗi bridge — bridge sau restart healthy, `/api/state` 200, tunnel up):

1. Đọc transcript thật của phiên treo: hai message `role: user`, **không có message assistant nào**,
   `session/status` = `{}` (không có run nào chạy), SSE `/opencode/event` chỉ có heartbeat.
2. `model` của message = `{providerID: "openrouter", modelID: "stealth"}`.
3. `GET /opencode/config/providers`: provider `openrouter` có 387 model, và id thật là
   **`stealth/space-bunny-alpha`** — **không tồn tại model nào tên `stealth`**.
4. `chat.jsx` từng có guard cho `owm_agent` (agent engine đã xoá → bỏ lựa chọn) nhưng **KHÔNG có
   guard tương tự cho `owm_model`**: giá trị trong `localStorage` được gửi thẳng xuống engine, không
   bao giờ đối chiếu với catalog vừa nhận. Máy nhớ `openrouter/stealth` từ lúc engine còn dùng tên
   cũ → mọi tin sau đó đều im lặng.
5. Xác nhận bằng prompt thật trên session tạm (đã xoá sau khi test): `modelID: "stealth/space-bunny-alpha"`
   → agent trả lời "PONG" trong ~25s. Cùng payload với `"stealth"` → không có gì.

Đây là điểm chết âm thầm đáng sợ: **engine nhận và lưu message rồi không làm gì cả**, không báo lỗi.
Cũng lưu ý `parseModelValue` cắt ở dấu `/` **đầu tiên** là đúng — id model của engine có thể chứa `/`
("9router/ag/claude-sonnet-4-6"); cắt bằng `split("/")[1]` là cách làm mất đuôi.

**Sửa** (`web/src/lib/model-behavior.js` + `chat.jsx`):
- `resolveKnownModel(stored, models)` — model nhớ mà không còn trong catalog thì chọn lại model đầu
  danh sách. Catalog **rỗng** (chưa tải xong / mạng hỏng) thì giữ nguyên giá trị đang nhớ, không
  xoá lựa chọn của người dùng chỉ vì một lượt fetch hỏng.
- `chat.jsx` gọi nó ngay sau khi `setModels(flat)`, đồng thời cập nhật `localStorage.owm_model`.
- `isModelUsable(value, models)` chặn ở `flushQueue` **trước khi gửi**: model không có trong catalog
  thì báo "Model đã chọn không còn trong danh sách của máy. Bấm nút model để chọn lại." và giữ nguyên
  hàng đợi. Đổi im lặng thành lời nói rõ + chỉ đường ra.

Test: `web/test/model-behavior.test.js` (27 test) khoá đúng ca `stealth/space-bunny-alpha` — id nhiều
dấu `/` không bị cắt, model cũ bị chặn, catalog rỗng thì không chặn nhầm. Web 314/314, build sạch.

**Cách gỡ ngay khi chưa deploy**: bấm nút model trên điện thoại và chọn lại "Space Bunny Alpha" —
`owm_model` trong máy được ghi đè bằng giá trị đúng, tin gửi lại là chạy.

## Office/binary downloads on the phone — 2026-10-04 (bridge/src/proxy.js)

`.xlsx`/`.docx`/`.pptx` links opened as a blank page instead of downloading. Cause chain, both halves
found by reading the real engine source (`apps/server/src/routes/files.ts:938`):

1. `GET /workspace/:id/files/raw` **always** answers `Content-Disposition: inline` — correct for the
   desktop, which renders the file in its own viewer, meaningless to a phone browser that has no
   viewer for a spreadsheet.
2. The bridge's existing `attachment` fallback had been **dead code**: its regex tested
   `upstreamPath` *with the query string*, and every real request carries `?path=`, so
   `"/workspace/ws_1/files/raw?path=x"` never matched `/files\/raw(\/|$)/`.

Fix: `rawPathOf()` strips the query before matching (revives the fallback), and a new exported
`shouldForceDownload(name)` forces `attachment` for the extension set no browser renders as a
document — Office, archives/installers, native binaries. Deliberately left `inline`: images (web
previews them with `<img>`), PDF (`<iframe>`), and media the browser plays itself. The filename is
re-encoded as `filename*=UTF-8''…` so Vietnamese names survive.

The Cloudflare worker passes the header through untouched (`new Headers(response.headers)`), so no
worker change is needed — but this only reaches the phone after the bridge restarts.

Tests: `bridge/test/proxy-download.test.js` runs two real local HTTP servers — an upstream that
answers exactly like the engine (`inline; filename=…`) and the real `proxyToOpenWork` in front — then
asserts xlsx becomes `attachment`, png/pdf stay `inline`, and a `Báo cáo Q3.xlsx` path keeps its
name. `bridge/test/bridge.test.js` covers the extension set. Bridge 57/57, web 309/309.

## Installer — 2026-10-03 (vendored node_modules, Node gate demoted, fresh-dist assert)

Goal: "one file, double-click, it just works." `desktop/build-setup.js` now (1) **vendors `bridge/node_modules` into the installer**: the production dependency closure is walked from `bridge/package-lock.json` (the bridge has exactly one dependency — `qrcode-terminal@0.12.0`, zero transitive deps) and copied from the dev tree with a per-package version check; a missing or version-mismatched package is a hard error telling you to `cd bridge && npm install`. The dev tree's removed-but-still-present packages are not in the lockfile and are never staged. The friend machine never runs npm — `OpenPocket.cs` only verifies deps via `EnsureBridgeDepsPresent()`; only `node.exe` itself is still needed to RUN the bridge. (2) **asserts `web/dist` freshness** before staging: the newest mtime across `web/src`, `web/public`, `index.html`, `vite.config.js`, `package.json` must be ≤ the newest dist mtime, else the build aborts ("rebuild first: cd web && npm run build") instead of silently shipping a stale bundle. (3) `--stage-only` runs the stage step alone (assert + stage, no exe) for verification. `desktop/src/OpenPocketSetup.cs`: the `HasNode()` gate is DEMOTED from "block install + open nodejs.org + return 1" to a Yes/No warning — the install always proceeds, the dialog just offers to open the Node download page (node.exe is still required to run the bridge, and the GUI's "Bật Bridge" reports it if missing); post-install failures are no longer swallowed — a failed Start-Menu/Desktop shortcut or a failed app launch is collected per item and shown in a "Đã cài xong, nhưng có việc chưa xong" warning box (`MakeShortcut` no longer catches internally, `Process.Start` failure names the exe path). `desktop/swap-gui.bat` uses `%~dp0` instead of the hardcoded dev-machine path; `desktop/build-test.bat` gained the same csc.exe existence guard + errorlevel report as `build.bat`. `HUONG-DAN.txt` no longer advertises the removed remote-control feature (removed in 2a202a3) — OpenPocket controls OpenWork (sessions, chat, files), and the first-run "1–2 phút npm install" wait is gone from the text since node_modules ships inside the installer. No `bridge/VERSION` is staged (the file is gone — `bridge/package.json` is the single version source). Verified: `node desktop/build-setup.js --stage-only` stages `bridge/node_modules` with ONLY `qrcode-terminal@0.12.0` (loaded from the stage tree and rendered a QR); the fresh-dist assert first fired for real — `web/src/api.js` (edited concurrently after the last build) was newer than dist — and passed after the standard `npm --prefix web run build`.

## Bridge zero-dependency — 2026-10-06 (qrcode-terminal vendored, node_modules gone)

The bridge's last npm dependency is gone. `qrcode-terminal@0.12.0` (Apache-2.0; QR engine by Kazuhiko Arase, MIT) is vendored as plain ESM source in `bridge/src/vendor/qrcode-terminal/` (10 `QRCode/*.js` engine files + the terminal renderer `index.js`, mechanically converted CommonJS→ESM, octal `\033` escapes rewritten to `\x1b`, LICENSE + attribution headers kept). Output equivalence was proven BEFORE the dependency was dropped: the npm copy and the vendored copy rendered byte-identical QR strings for five inputs (short/long pairing URLs, master-token URL, big-renderer fallback). `bridge/package.json` carries no `dependencies` and `bridge/package-lock.json` is deleted — the bridge now runs from `node src/index.js` with zero npm install, ever. Consequences: `desktop/build-setup.js` no longer walks the lockfile or stages `node_modules` (`productionClosure`/`stageNodeModules` deleted); `EnsureBridgeDepsPresent()` in `OpenPocket.cs` verifies only `bridge\src\index.js` + `node.exe` (the `node_modules` MessageBox branch is gone); installer comments updated. Verified: `node --check` on every touched file, bridge suite 111/111, `desktop\build.bat` compiles, `build-setup.js --stage-only` stages a node_modules-free package. This supersedes the vendoring approach of the Installer 2026-10-03 section below (kept as history).

## Desktop GUI hardening — 2026-10-03 (desktop/src/OpenPocket.cs only)

| Symptom | Fix |
|---|---|
| Quitting from the tray while a background callback was still in flight ("Restart tunnel" + "Thoát hẳn" within ~8 s) crashed the whole process with ObjectDisposedException — six raw `this.Invoke` sites with no disposed-guard | New `MainForm.SafeInvoke(Control, Action)` static helper + instance `SafeInvoke(Action)` wrapper: checks `IsDisposed`/`IsHandleCreated` BEFORE marshalling, falls back to a direct call when already on the UI thread, and swallows the dispose race (`ObjectDisposedException` / `InvalidOperationException`). Every former `this.Invoke` site now routes through it: `BeginProvisionIfNeeded`, `ActionStartBridge`, `PostBridgeJson`, and both `PairingQrDialog.FetchLiveCode` callbacks. |
| Three `WaitForExit()` calls with no timeout ran `schtasks` on the UI thread — the window froze for seconds | `IsAutostartTaskExisting`, `EnsureAutostartTaskEnabled`, `DisableAutostartTask` now use `WaitForExit(10000)`; `ExitCode` reads are guarded behind the returned `exited` flag (reading it before the process exits throws `InvalidOperationException`). |
| The WMI stop fallback killed ANY `node.exe` whose command line merely contained the substrings "bridge" AND "index.js" — it murdered somebody else's bridge running from a different folder on the same machine | The match now requires the FULL entry-script path `bridgeDir\src\index.js` (case- and slash-normalized) inside the command line; when `bridgeDir` was never resolved the WMI sweep is skipped entirely instead of killing blind. The pid-file path is untouched and still covers CLI-started bridges. |
| "Bật Bridge" ignored the `schtasks /run` exit code AND silently re-created the autostart task the user had just unticked | `/run` now runs under `using (Process …)` with a 10 s wait: a timeout or non-zero exit shows a MessageBox carrying schtasks' stderr/stdout and aborts. The automatic `EnsureAutostartTaskEnabled()` call is GONE — the scheduled task is created ONLY by ticking the autostart checkbox. When no task exists (fresh install, or the user turned autostart off), `StartBridgeDirect()` boots node directly: hidden window, stdout/stderr appended to `bridge-task.log` (the same command line the task's .vbs used), elevation inherited from the elevated GUI — "Bật Bridge" always starts the bridge, autostart stays exactly what the checkbox says. |
| The 3.5 s poll stuttered weak machines: a 500 ms port probe plus a full `ReadToEnd` of BOTH log files on every tick | Port probe timeout 500→150 ms (localhost needs no more); `ReadTunnelUrlFromLog` reads only the last 32 KB of each log via `FileStream.Seek` — the trycloudflare URL always sits in the newest lines. |
| First-run provision failure was swallowed SILENTLY: the friend saw a green bridge light while the machine never appeared on the phone | The worker thread captures the exception message into `provisionError`; a new status row "Định danh máy" on the status card shows provisioning in amber, `THẤT BẠI — <reason>` in red with an ↻ retry button (`ActionRetryProvision`), or a green "bấm Khởi động lại Bridge" hint after a successful provision while the bridge is running (the hint clears the next time the bridge stops). The row hides completely on healthy already-provisioned machines (status card 164→188 px, window 496×372→496×396). |
| The runtime `npm install` block (up to a 5-minute silent wait on a background thread) is obsolete now that the installer vendors `node_modules` (see the Installer section above) | Deleted together with the `bridgeNeedsInstall` field and the `EnsureBridgeInstalledAsync` method. Replaced by a synchronous `EnsureBridgeDepsPresent()` that verifies `bridge\src\index.js`, `node.exe` and `bridge\node_modules`, with one precise MessageBox per missing piece instead of an invisible minutes-long install. Matches the installer stream's `616238c` (vendored dependency, Node gate demoted). |

Check: compiled `desktop/src/OpenPocket.cs` with `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` (C# 5) to `%TEMP%\openpocket-check.exe` using the exact flag set of `desktop/build-test.bat` (`/target:winexe /optimize /codepage:65001 /win32icon:src\app.ico`, refs System, System.Drawing, System.Windows.Forms, System.Web.Extensions, System.Management) — exit code 0, zero warnings/errors, 59,904-byte exe produced. The check build never wrote to `desktop/bin/OpenPocket.exe` (timestamp unchanged), and the GUI exe was NOT launched, so no bridge start, no scheduled-task change and no touch of the real `%APPDATA%\openwork-bridge` — the OPENWORK_BRIDGE_DIR/OPENWORK_DIR redirection rule was not needed because no test process ran.

Known leftovers: (1) `FindNodeExe()` still contains one unbounded `p.WaitForExit()` on `where.exe` — outside this pass's three named sites, fast in practice; (2) README.md §"Desktop helper app" used to advertise the removed runtime npm install + auto task creation — FIXED in this docs pass (README now describes `EnsureBridgeDepsPresent` + the vendored installer).

