# CODE_SUMMARY — OpenWork Mobile

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

> ⚠️ **`web/dist/_headers` is STALE — rebuild before any deploy.** The newest build
> ran 2026-10-04 21:12 and does contain the UI compaction below (`web/src/styles.css`
> mtime 19:17 < 21:12), but `web/public/_headers` was edited **after** that build, so
> the copied `web/dist/_headers` still holds only the CSP line — `cat web/dist/_headers`
> has no `nosniff` and no `referrer-policy`, while the source has both. The Worker
> uploads assets straight from that directory (`worker/wrangler.jsonc` →
> `"assets": { "directory": "../web/dist" }`) and the bridge serves the same folder in
> `bridge/src/static.js`, so `cd worker && npx wrangler deploy` without
> `npm --prefix web run build` publishes the old `_headers`. Build first.

> **Commit state: FIX-1 only.** `8020ef1 bridge: stop returning the master token to
> device keys` (routes/pairing.js + its test) is committed. FIX-2, FIX-3 and FIX-4 —
> `bridge/src/static.js`, `web/public/_headers`, `worker/src/index.js`,
> `bridge/test/static-headers.test.js`, `worker/test/relay.test.mjs` — are **working
> tree only, uncommitted**, each still owed its own commit.
> The web UI compaction at the top of this file (`web/src/styles.css`,
> `pages/home.jsx`, `pages/sessions.jsx`) rides in the same working tree but is **not
> part of the security round** — it needs its own commit, otherwise one `npm run build`
> would mix an unrelated layout change into the security history.

> ⚠️ **NOT DEPLOYED, BRIDGE NOT RESTARTED.** No `wrangler deploy` was run and no
> bridge/cloudflared process was restarted in this round (restarting mints a brand
> new Quick Tunnel and costs against the CF 429 quota anyway), so **none of the four
> fixes is live yet**: the phone still gets the master token from `/api/pairing-code`,
> still gets headerless static over the tunnel, and the worker still relays
> `/api/pair` unthrottled. Deploy order is the spec's: one bridge restart for
> FIX-1+2, one worker deploy for FIX-2+3+4, then verify live with
> `curl -s -D - -o /dev/null http://127.0.0.1:8788/ | grep -i "content-security\|nosniff\|referrer"`
> and a `/api/pairing-code` call with a device key (no `masterUrl` left).

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

> Last updated: 2026-10-04 — parity rounds closed: session extras (cost, rename, /compact, steer,
> effort/variant, cross-session search, pin/archive/groups, share) and Settings maintenance
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

## Whole architecture (1 line)

The phone opens **exactly 1 fixed URL** (`https://YOUR-WORKER.workers.dev`) → the Worker picks the "room" from the `x-owm-tenant` header (missing = the worker owner's `machine:main`) and relays to that room's CURRENT tunnel address (bridge heartbeat every 15 minutes; a tunnel change is reported immediately) → **openwork-bridge** (127.0.0.1:8788) → **openwork-server** (API shipped inside OpenWork, dynamic port) → opencode engine.

```
[Phone: PWA — a single fixed URL, plus room (x-owm-tenant header / ?_m=)]
        │  HTTPS via CF edge
        ▼
[Worker openpocket]  ←relays /api/* to the ROOM's tunnel (auth intact, keys verified by the bridge)
        │  + serves the web app static + manages rooms tenant:<id> on KV
        ▼ (bridge heartbeats its current URL every 15 min; stale >20 min = offline)
[bridge :8788]  ←proxy whitelist, injects Bearer owt_ owner→  [openwork-server]*  →  [opencode engine]
                                                                    (*dynamic port)
```

## Why this architecture

- OpenWork desktop (Electron) already runs **openwork-server** with a full API: workspaces, session-groups, approvals, file read/write, SSE events, and the **`/workspace/:id/opencode/*` proxy mount** (send `prompt_async`, abort, permission reply...). The bridge does NOT re-invent the API — it forwards a selected surface only.
- openwork-server auth uses `Authorization: Bearer owt_...` (scope `owner` = full). Tokens are stored **sha256**-hashed in `%APPDATA%\openwork\tokens.json`, and the server loads them once at startup → the bridge mints its token into that file; restarting OpenWork **exactly once** makes it permanent.
- The openwork-server port is dynamic (62222 at the moment) → the bridge finds it itself: reads `engine-instances.json` for `ownerPid` → `netstat -ano` for that pid's ports → probes `GET /health` (a payload containing `opencodeVersion` is the right server).
- All API misunderstandings were resolved by inspecting `app.asar` (extract with `npx @electron/asar extract`) — `server/dist/*.js` is the openwork-server code, `app-dist/assets/app-*.js` is the official SPA (ground truth for request/response shapes).

## File map

### bridge/ (Node.js ≥20; deps: `qrcode-terminal` only — `bridge/package.json`)

| File | Responsibility |
|---|---|
| `src/index.js` | Entry: bootstrap token → discovery loop (5s + fs.watch) → hand `createApp()` its singletons → listen (with the EADDRINUSE retry) → SIGINT + uncaughtException net. Prints the pairing QR (**`currentBase()` uses the unit-tested `pairingBaseUrl()` from config.js: the worker address only wins WITH a room; the QR link carries `&m=<room>`**). Owns the mutable singletons the HTTP layer reads — `config`, `state`, `pairing`, and the `tunnel` holder whose `getState`/`restart` are swapped for the real cloudflared controller once `startQuickTunnel` resolves. Single version source: `bridge/package.json` (the old VERSION file is gone). |
| `src/app.js` | The HTTP surface, extracted so it is testable. `createApp(deps)` builds the route table + auth gate and returns `{server, handleRequest, ctx, routes}`. Before this, `handleRequest` was a ~500-line if-chain inside `index.js` — a file exporting NOTHING, so not one of the test files could reach it: a mistyped `/api/...` path stayed green until runtime. `index.js` still boots/discovers/listens and only hands over its singletons; nothing in the route layer reads module-level state. **The gate order is preserved exactly**: `/api/pair` and `/api/pair/tenant` run BEFORE the gate (a stranger must be able to pair in), everything else needs the master `owm_` OR a device key `owd_` (header OR `?_t=` on GET), and an unknown `/api/` path still answers **401 without a token — 404 `not_found` only once you hold one**, so the phone cannot probe which endpoints exist. Route **`POST /api/pair/tenant`** (multi-tenant sign-in: compares user/pass against config; on match `mintDevice` + returns `{token, device, tenant, machineName}`; not joined → 404 `not_joined`; rate-limited together with /api/pair). `/api/state` also carries `edge: {tenant, machineName}` and **`openwork: {found, exe, version, source, running, candidates}` from `describeOpenWorkInstall()` (openwork-version.js) — the legacy `openworkExeFound` boolean stays in the contract and is now read from the SAME lookup, so version + origin cost one probe, not two**. Both `/api/state` and `POST /api/openwork/path` build that object through ONE helper `openworkStateInfo()` so the two can never drift. `candidates` are now sent **even when the exe was found** — reinstalling OpenWork elsewhere is an ordinary event and needs the same chooser, not a dead verdict; `running` comes from `isProcessAlive(engine.ownerPid)` because `engine-instances.json` survives the app closing, so "has an entry" ≠ "is open". Route **`POST /api/openwork/path`** (body `{path}` → saves `config.openworkExe`, answers `{ok, openwork}`): added AFTER the auth gate and deliberately sharing `wakeRateLimited` (5/min/IP) with `/api/openwork/wake` — no new limiter family. It only **validates + stores, never spawns** (`normalizeExePathInput()` → `existsSync` + `statSync().isFile()` + `isOpenWorkExeName()`), because the stored value IS what wake/boot launch later — hence the name check is the RCE guard. Quote-stripping must run **before** the name check: a path pasted from PowerShell is `"C:\...\OpenWork.exe"`, whose raw basename carries the quote and would be rejected as the wrong file name. |
| `src/router.js` | Route matching over the declared table: exact string, RegExp, or `"*/prefix"`, first match wins, `method: "*"` for any verb. Order is the contract — the `/api/ow/` proxy is a prefix and therefore sits last. |
| `src/routes/pairing.js` | `/api/pair`, `/api/pair/tenant` (the two public routes), `/api/devices`, `DELETE /api/devices/:id`, `/api/pairing-code` (ASCII QR rendered here so the desktop GUI never fetches a code that never leaves the machine). |
| `src/routes/status.js` | `/api/state`, `/api/recheck`, `/api/tunnel/restart`, `/api/machine/name`. |
| `src/routes/openwork.js` | `/api/openwork/wake` and `/api/openwork/path`, sharing the one 5/min/IP limiter. |
| `src/routes/fs.js` | `/api/fs/ls`, `/api/fs/mkdir` (workspace folder picker, behind the same device lock). |
| `src/routes/proxy.js` | `/api/ow/` → openwork-server with the owner token; 503 distinguishes `restart_required` from `upstream_unavailable`. |
| `src/rate-limit.js` | Sliding-window per-IP limiter + the sweep that stops the maps growing with every IP ever seen. Pure, so the limits are testable without an HTTP server. |
| `src/http-util.js` | `readJsonBody()` (1 MB cap) and `sendJson()` — replaces ~25 hand-repeated `writeHead + JSON.stringify` pairs. |
| `src/openwork-state.js` | `openworkStateInfo()`, the ONE shape both `/api/state` and `POST /api/openwork/path` answer with, so they cannot drift. |
| `src/config.js` | Runtime config (mobileToken `owm_`, ownerToken `owt_`, port, publicUrl, **lookupUrl + lookupSecret + lookupTenant + machineName**). Lives OUTSIDE the repo: `%APPDATA%\openwork-bridge\config.json`. Empty `lookupTenant` = the machine is NOT a room on the shared worker: the worker refuses roomless web entry (400 `tenant_required`), so **`pairingBaseUrl()`** (pure + unit-tested in `test/config.test.js`) points pairing QRs at the tunnel/public URL instead of the worker; the heartbeat still registers the tunnel under the owner's legacy `machine:main` slot (API relay only, no web login). |
| `src/bootstrap.js` | Mints/appends the owner token into `%APPDATA%\openwork\tokens.json` (atomic + .bak). hash = plain sha256 hex, fixed id `openwork-mobile-bridge`. |
| `src/discovery.js` | Reads `engine-instances.json` (ownerPid) → parses netstat → probes `/health` → checks `/whoami` (token active). **`isProcessAlive(pid)`** = `process.kill(pid, 0)` (no child process, unlike a `tasklist` spawn; `EPERM` still counts as alive) — needed because the registry file outlives the app, so `/api/state` can report "installed but not running" honestly. |
| `src/proxy.js` | Reverse proxy `/api/ow/*` → openwork-server. Whitelist after **dot-segment normalization**, method allowlist, injects Bearer owner, **body buffering (64MB cap)**, streams the response + SSE keepalive 20s. Also forwards `content-length/content-range/accept-ranges` so downloads show progress, and **rewrites `content-disposition` on `/files/raw`** (see "Office/binary downloads on the phone"). |
| `src/auth.js` | Phone → bridge: `owm_` token (header) + `?_t=` (GET only, for EventSource/img). timingSafeEqual. `requestToken()` extracts from both sources, `isTokenAuthorized()` accepts both alike. |
| `src/static.js` | Serves `web/dist` (SPA fallback to index.html); traversal out of root blocked; a mid-stat vanish answers a clean 500 JSON instead of an uncaughtException. **2026-10-04**: stamps `SECURITY_HEADERS` (CSP + `x-content-type-options: nosniff` + `referrer-policy: no-referrer`) on the 200 branch, because this is the tunnel door that bypasses the worker entirely — one of three copies of that CSP that must stay identical |
| `src/pairing.js` | 9Remote-style pairing: one-time 8-char code (30 min, single use, printed in the QR), permanent device key owd_ (hash stored in devices.json), revocation. **`mintDevice(label)`** issues a key without a code — shared by code-pairing and room sign-in `/api/pair/tenant`. |
| `src/tunnel.js` | Auto Cloudflare Quick Tunnel (learned from 9Remote): downloads cloudflared into the data dir, spawns `tunnel --url :8788` with `--protocol http2 --edge-ip-version 4` (TCP/443 instead of flaky QUIC/UDP), scrapes the trycloudflare.com URL from logs, restarts it when it dies, calls `onUrl` (index.js prints a fresh QR). Disable with `OPENWORK_BRIDGE_TUNNEL=0`. **Backoff against CF 429/1015 rate-limit**: waits 120s doubling, cap 10 min; exit code **-1 (4294967295 — edge dumps the tunnel right after provisioning while the IP is flagged) also joins the long-wait streak**; all retry paths funnel through one guarded `scheduleRetry` (exit + error can't double-book), a spawn error retries after 60s, and every attempt logs `chạy cloudflared (đợt N)`. The backoff state is PERSISTED to `tunnel-state.json` (`saveTunnelState`/`loadTunnelState`/`rateLimitDelayMs`/`plainRetryDelayMs` pure exports, unit-tested) — a restarted bridge re-reads it and waits out the remaining time. `getState()` exposes `{phase: starting|up|backoff, url, streak, nextRetryAt}` to index.js (→ `/api/state` + the lookup heartbeats). **Manual `restart()`**: cancels `pendingRetryTimer`, zeroes streak/attempt/`nextRetryAt`, kills the live child (late exits self-suppress) and calls `runOnce()` right away; `restarting` flag guards re-entrancy. Wired to `POST /api/tunnel/restart` + the GUI's inline ↻ icon. |
| `src/lookup.js` | Heartbeat to the Worker (the fixed address): registers the current tunnel URL the moment it changes + keeps warm every **15 minutes** (saves free KV, ~96 writes/day/room; the worker treats >20 min as offline). With a `tenant`, sends it in the body `{url, tenant}` (lowercase). Takes a `getState()` from tunnel.js — when the phase is NOT `up` (judged by phase, not by `getUrl()` being empty), it registers a "presence without URL" `{url: "", tunnelDown: true, retryAt}` on state change + the 15-min warm-up beat (bucketed, so an outage costs only a handful of KV writes) and the worker/phone can then say "machine alive, tunnel waiting" instead of "offline"; register 401/400 backs off exponentially 15s→5 min with ONE clear log line. |
| `src/openwork-launch.js` | Locates OpenWork.exe (env `OPENWORK_EXE` → config `openworkExe` → `%LOCALAPPDATA%\Programs\@openworkdesktop\`) + launches the app detached & hidden. Used by the wake endpoint + auto-launch at boot. `candidateExeEntries()` keeps the `source` (env/config/wellknown) beside each path so `/api/state` can report where the exe came from; **`isOpenWorkExeName()`** is the guard for paths typed on the phone (`POST /api/openwork/path`) — it accepts only a file named exactly `OpenWork.exe`, because whatever that route stores in `config.openworkExe` is later `spawn()`ed for real by wake/auto-launch, so `existsSync + isFile()` alone would let a phone point the bridge at any executable on the machine. **`normalizeExePathInput(raw)`** strips surrounding quotes (up to 2 layers) before any check: "Copy as path" in PowerShell yields `"C:\...\OpenWork.exe"` with quotes, pasted verbatim it never matches a real file, and its basename `"OpenWork.exe"` would fail the name guard as the wrong file name. |
| `src/openwork-version.js` | Reports the **installed OpenWork desktop version** to the phone (`bridge/src/openwork-version.js`, new 2026-10-03, pure Node, no new dependency). Reads `resources/app.asar` → `package.json`: Chromium-Pickle header (len JSON at offset 12, payload from `8 + headerSize`), `readExact()` chunked reads so the 225 MB exe is never slurped, every failure swallowed → `null`/`""`. **No PowerShell spawn fallback** — `/api/state` is polled by the phone every 15s and a process per poll is not worth a version string; missing asar just renders "không đọc được". `openworkVersionFrom()` caches the string per asar path + `mtimeMs:size` (~13 ms and a 3.5 MB `JSON.parse` per hit on a real install, down to ~0.02 ms cached; upgrading the app invalidates it). `describeOpenWorkInstall({configOpenworkExe})` → `{found, exe, version, source}`, never throws. Unit-tested against a **fake asar written in a temp dir** — no test touches the real `%LOCALAPPDATA%`. |
| `src/logwipe.js` | Log auto-wipe (logs are not kept on the machine): `wipeLogs()` truncates all three logs — safe while the bridge RUNS because every writer opens append, so existing handles keep writing at the new EOF; `deleteLogs()` unlinks with a truncate fallback for callers that already killed the bridge; `rotateStaleLogs()` truncates logs whose mtime is not today (called at boot BEFORE any banner `console.log`); `scheduleDailyWipe()` arms an unref'd timer for the next local midnight. Callers: `index.js` (boot + SIGINT), `bin/openpocket.js` stop, the GUI (`WipeLogFiles`). Pure dir parameter → unit-tested in `test/bridge.test.js`. |
| `src/autostart.js` | Builds the schtasks command for `openpocket autostart` (task `OpenPocketBridge`, ONLOGON, quoting paths with spaces). |
| `src/fslist.js` | Folder browsing behind the "Browse…" button when creating a workspace: `listRoots()` (Windows drives scanned A–Z + quick links (real folder names, e.g. user/Desktop/Documents/Downloads)) and `listDirs(path)` (DIRS ONLY — no files leak, hidden `.`/system junk skipped, symlinks resolved to target, sorted A→Z vi-locale). `makeDir(dir, name)` creates a subfolder (blocks forbidden chars, clear error on name clash). |
| `bin/openpocket.js` | Global command, TRIMMED 13/09 to the one-PC machine toolset: **start / stop / status / logs / code / autostart / watchdog / ensure** — nothing else. `status` absorbed the old room line; `code` prints the live one-time code + master QR (fetched from the bridge API, log-parse fallback). Kept machinery: pid-file read with tasklist verification for elevated instances, TCP port-busy probe (no EADDRINUSE double-starts), `ensure` self-heal (the watchdog task calls `node <abs path> ensure` — NOT the npm shim). ESM — use the imported spawnSync. `status` reads `tunnel-state.json` — while the 429 backoff is active it prints the remaining minutes plus an explicit "ĐỪNG restart bridge" warning instead of a stale tunnel URL. |
| `src/paths.js` | `%APPDATA%\openwork` location (env `OPENWORK_DIR` overrides for tests). |
| `test/auth.test.js` | Token sources: bearer-only for admin routes, `?_t=` query token accepted (EventSource/img), sha256 hash scheme. |
| `test/bridge.test.js` | Netstat parse, proxy whitelist + dot-segment traversal + method allowlist, `files/raw` disposition fallback, OpenWork.exe locate, autostart quoting, `listDirs`/`makeDir`, logwipe, config validation + `pairingBaseUrl`. |
| `test/config.test.js` | Config.json garbage values never override validated defaults; valid values win; `pairingBaseUrl` — the worker base only wins WITH a room, roomless falls back to tunnel/public (extended this round). |
| `test/listener.test.js` | The listener stops after ten EADDRINUSE retries (shared counter). |
| `test/lookup.test.js` | Heartbeat: registers IMMEDIATELY at startup (body carries lowercase `tenant`), no tenant keeps the old body `{url}`, warm-up beats don't re-write, URL change re-registers at once, tunnel-down reports `tunnelDown` by phase (not by an empty getter), 401 backs off. |
| `test/pairing.test.js` | One-time code (single use, wrong/expired), device keys + revocation, disk persistence, `mintDevice` (key without code, doesn't consume the one-time code). |
| `test/startup.test.js` | Boots a REAL isolated bridge process (temp `OPENWORK_BRIDGE_DIR`/`OPENWORK_DIR`, tunnel off, dynamic port): authenticated vs unauthenticated HTTP, occupied-port retry, stdout carries neither credential nor one-time code. |
| `test/routes.test.js` | The route table over real HTTP against `createApp` (23 cases, no bridge process, temp `OPENWORK_BRIDGE_DIR`): the auth gate, that unknown `/api/` paths 401 before 404, `?_t=` on GET, device mint/revoke, the 10/min `/api/pair` ceiling, `/api/ow/` 503s, and that a throwing route answers 500 JSON instead of killing the process. |
| `test/static.test.js` | `%2e%2e`/`../` out of root blocked; real file + SPA fallback still serve; a file vanishing between stat and open → clean 500 JSON, no uncaughtException. |
| `test/tunnel.test.js` | 429 backoff ladder (2 min doubling, 10 min cap; plain retry 5s cap 60s) + state persistence across restart via `tunnel-state.json`. |
| `test/openwork-launch.test.js` | `isOpenWorkExeName()` — the phone-typed-path guard: `OpenWork.exe` accepted case-insensitively; `calc.exe`, `cmd.exe`, a `.txt`, `MyOpenWork.exe`, `OpenWork.exe.bak`, empty/null rejected. `normalizeExePathInput()` — quotes stripped (PowerShell single/double, two nesting layers), ordinary paths untouched, a quote in the middle of the name NOT treated as a wrapper, and the ordering invariant: a still-quoted path fails the name guard, the normalized one passes. |
| `test/openwork-version.test.js` | Fake asar in a temp dir (16-byte header + padded JSON + payload): version parsed, nested `package.json` found, unaligned JSON length still lands on the right payload offset, missing/tiny/truncated/corrupt-header/wrong-magic/over-`HEADER_MAX_BYTES` all → `null` without throwing, `describeOpenWorkInstall` source = config/env/not-found (`LOCALAPPDATA`/`PROGRAMFILES`/`OPENWORK_EXE` redirected to temp dirs — the dev machine really does have OpenWork installed). |
| `test/openwork-routes.test.js` | **End-to-end HTTP over a REAL spawned bridge** (same isolation recipe as `startup.test.js`: temp `OPENWORK_BRIDGE_DIR`/`OPENWORK_DIR`, tunnel off, dynamic port) for the two OpenWork routes, which had no HTTP-level coverage at all because `handleRequest` isn't exported and `index.js` listens on import. Asserts: `POST /api/openwork/path` 401 without a token, and 400 for empty / non-existent / directory input; **`not_openwork_exe` for a temp `calc.exe`** — the RCE guard, verified through the wire rather than by calling the helper; a PowerShell-quoted path is accepted; `POST /api/openwork/wake` returns `openwork_exe_not_found` **with** a `candidates` array. Two bridge instances are spawned on purpose so the shared 5/min/IP rate limit can actually be crossed (`assertNotRateLimited` catches a test that accidentally became the victim of it); `LOCALAPPDATA`/`PROGRAMFILES` are neutralised for every spawned bridge and the found exe is asserted to come from the sandbox, so a dev machine with OpenWork really installed can never make these pass/fail by accident. Every child is killed in teardown — an earlier round left orphans holding ports. |
| `scripts/e2e-live.mjs` | E2E: create session → prompt_async → poll reply → delete. `node scripts/e2e-live.mjs <wsId> <providerId> <modelId>` |
| `scripts/dbg-prompt.mjs` | Prompt debug: dumps status + parts every 5s. |

**Total: 53 bridge tests, all green (`cmd /c npm --prefix bridge test`, 2026-10-03).**

### worker/ (Cloudflare Worker `openpocket` — "fixed address" + multi-tenant)

| File | Responsibility |
|---|---|
| `src/index.js` | KV holds 2 key kinds: `tenant:<id>` = `{secret, name, createdAt}` (accounts issued by the script or self-serve) and `machine:<id>` = `{url, updatedAt}` (the room's current tunnel; `machine:main` = the worker owner's machine, secret env `BRIDGE_SECRET`, no tenant). `POST /__register`: a `tenant` in the body → compares the secret against `tenant:<id>` (timing-safe); otherwise the legacy flow. `/api/*`: picks the slot by `x-owm-tenant` header / `?_m=` (EventSource) / empty = main; specifically `POST /api/pair/tenant` reads the room from `body.user` and **the worker compares the secret BEFORE relaying — unknown room and wrong password return the same 401, so no room's existence can be probed** (the bridge re-checks the password a second time). **Open doors are rate-limited through the Cache API (`rateLimited(request, kind, limit)` — `caches.default`, no KV writes): sign-in 10/min/IP, self-serve room creation 5/min/IP, and — since 2026-10-04 — device pairing 10/min/IP, which must live HERE rather than on the bridge because only the worker sees a real client IP (`cf-connecting-ip`; every cloudflared request reaches the bridge as `127.0.0.1`). The room-creation door is closable with the env var `ALLOW_ROOM_CREATE=0` → 403 `room_create_disabled` (unset/`"1"` = open, as before).** **`POST /api/tenant/create` = SELF-SERVE room creation (the desktop GUI's silent provisioning)**: body `{user, secret, name}`; reserved names `main/admin/root/api/www` (creating `tenant:main` would let a stranger's bridge overwrite the owner's `machine:main` address — the one real hijack), password 8–128 chars without `space " ' : &`; **existing room + exact same secret = `{ok, existed:true}`** (reinstall the machine → provisioning reconnects), existing + wrong secret = the same generic 401; a new room costs 1 KV `list` (checked against the **50-room cap**) + 1 `put`. **Dormant door since the one-PC simplification (13/09): the GUI calls `/api/tenant/create` BY ITSELF (random room + secret, user never sees a form) and the web's account login was removed, so no UI offers these forms anymore.** Offline when stale >**20 minutes**. **The relay requests `accept-encoding: identity` and unwraps `content-encoding: gzip/deflate` via `DecompressionStream`** — the CF edge used to compress the tunnel response itself, handing garbage bodies to clients that never asked for gzip. Everything else serves the web static from assets, **stamped with a `Content-Security-Policy` header (`withSecurityHeaders`)**: scripts strictly same-origin (no inline), styles inline-only, `img-src` allows `data:`/`blob:` for file previews. Loosen it there when web ever needs a CDN script or iframe. **v3.3**: `/__register` also accepts `{url: "", tunnelDown: true, retryAt}` via `storeRegister()` (slot stays fresh, `url` empty, flag kept) and the relay returns **503 `tunnel_down`** for a fresh slot carrying that flag — message says the machine is alive and gives the retry ETA — and wraps CF edge error statuses (520–527/530) into clean `tunnel_down` 502 JSON instead of forwarding the raw Cloudflare error page to the phone. Roomless `POST /api/pair` / `GET /api/state` → **400 `tenant_required`** with a message naming the paths that still exist (reworded 2026-10-03: the sign-in UI is gone — rescan the QR / re-open the full `&m=` link from the computer, or type the room in the Phòng box). |
| `wrangler.jsonc` | name `openpocket` + assets `../web/dist` (SPA, run_worker_first `/api/*` `/__register`) + KV binding. Commands: `npx wrangler kv namespace create` → `wrangler secret put BRIDGE_SECRET` → `wrangler deploy`. |
| `scripts/tenant.mjs` | Owner-side room admin on KV (requires logged-in wrangler): `add <user> "Name" [url] [--pass <pass>]` (no `--pass` → auto-generates a strong `owes_...`, ≥8 chars, no space/:/&), `list`, `revoke <user>` (deletes both `tenant:` and `machine:`). It still prints an `#i=user:secret` link, but NOTE: the web no longer consumes `#i=` links (the sign-in form was removed with the one-PC simplification) — the link is informational now; rooms are consumed by the GUI's silent provisioning or by pasting user/pass nowhere (no UI). Reads the namespace id from wrangler.jsonc. **Calls wrangler DIRECTLY `node …/web/node_modules/wrangler/bin/wrangler.js`, NOT via a shell** — the old `spawnSync("npx", …, shell:true)` let Windows cmd swallow the JSON quotes, so KV stored `{secret:…}` that wasn't valid JSON (sign-in always 401 despite the right password); a get returning 404 is treated as "room doesn't exist", not an error. Default worker URL comes from env `OWM_WORKER_URL` (or the `[url]` argument) — no real URL is committed. |

### web/ (Preact + Vite → dist ~99KB raw / ~31KB gzipped, "desktop-first" design)

| File | Responsibility |
|---|---|
| `src/styles.css` | v4 design tokens (skill `.zcode/skills/pwa-workspace-ui/references/tokens.md`): light/dark follows the system (backgrounds `#f8fafc`/`#111113`), primary button BLACK/WHITE via `--primary`, workspace identity color paints the **whole card** (`.ws-card` left stripe + tinted `.tile` via `--ws-c`), official hexagon logo `openwork-mark.svg` (`-dark` variant for dark mode), floating 3-tab nav + FAB, skeleton loading, safe-area, 16px inputs (no iOS zoom), 44px touch targets. **Back button `.topbar-back`** pinned on the sticky topbar (never scrolls away). **Motion tokens**: `:root` owns `--dur-tap 120ms / --dur-ui 200ms / --dur-move 300ms / --dur-spin 800ms / --dur-shimmer 1200ms / --dur-pulse 1600ms` + `--ease cubic-bezier(.2,.7,.3,1)`; buttons transition `transform/filter/opacity` only (never `width/height/margin`) and press to `scale(0.97)`. **Component styles**: `.pair-*` pairing page (hero code input, room box), `.model-pill/.model-sheet/.model-search/.model-list/.model-option` bottom-sheet model picker, `.fold-row` slim ZCode-style collapsible rows (tool + reasoning — no card chrome, body opens behind a thin left rule), `.file-row` text-only file rows, `.chat-status` persistent `aria-live` line, `.pc-*` machine rows in Settings, `.bottomnav` 3 tabs (max-width 420px). **2026-10-03 sweep**: the removed viewer page's CSS block (~475 lines: its `@media` section, touch-echo, stage chrome, full-viewport layering) and the multi-machine keychain card CSS (`.pulse-dot` keyframes included) were DELETED — zero JSX references remained; bundle CSS 27.61 kB → 19.90 kB. Changing the look = edit this file + tokens.md. |
| `src/components/ui.jsx` | Loading, SkeletonList, Empty (icon + CTA), Banner, ConfirmDialog (replaces native `confirm()`), `useConfirm()` hook, **`SwipeRow`** — swipe-to-reveal-a-button row (iOS/Zalo style): horizontal pointer-drag past 40% of `actionWidth` snaps open, vertical drags still scroll (`touch-action: pan-y`), the browser's post-drag click is filtered by a 400ms window (`dragEndAt` vs `performance.now()`), tapping the open row or outside closes it; the `onTap` fallback still fires navigation clicks. (The unused `BackButton` was removed 2026-10-03.) |
| `src/components/logo.jsx` | OpenWorkMark (official SVG img, auto-switches `-dark` via prefers-color-scheme). |
| `src/components/icons.jsx` | In-house SVG stroke set, 17 exports: Folder/File/Image/Upload/Download/Refresh/Back/Plus/Ws/Gear/Message/Clip/Stop/Pcs/Search/Check/ChevronDown — no emoji as icons. (9 unused icons were removed 2026-10-03; `ExpandIcon` followed the same day once the chat file rows stopped using it.) |
| `src/components/model-picker.jsx` | Bottom-sheet model picker: search box, "Gần đây" group (last 4 picks in `owm_model_recent`), provider groups sorted by name, check mark on the current model, 44px rows, 16px input (no iOS zoom). Replaced the flat `<select>`. |
| `src/api.js` | Token localStorage + auto-pair from `#t=`; **multi-tenant: the room (`owm_tenant`/`owm_tenant_name`) is stored alongside, `tenantHeaders()` attaches `x-owm-tenant` to every request (and **no credential ever rides a URL** — `blobUrlFor()` returns `blob:` object URLs for `<img>`/`<iframe>` since 2026-10-04; `sseUrl()` and its `?_t=` are gone), new hashes `#p=CODE&m=ROOM` / `#t=TOKEN&m=ROOM` store the room too**; `ow()` fetches via `/api/ow`, unwraps `.data`, and maps 401 → `Error("UNPAIRED")`; non-OK throws with `error.status` + `payload.message` + `error.code` (machine-readable, e.g. `tenant_required` — set by `apiPair` so the pairing page can react to the error KIND). **`owDeleteSession(wsId, sid)`** = `DELETE /workspace/:wsId/opencode/session/:sid` — the swipe-to-delete action on both session lists. **Keyring (internal plumbing, NOT a UI anymore)**: `owm_keys` = `[{tenant, token, name, addedAt}]` — `addKey()` dedupes by tenant (re-pairing the same room replaces its entry), `removeKey()` promotes the next key / clears `owm_token`+`owm_tenant` when empty, `migrateKeys()` (exported, idempotent, lazy) pulls the legacy single token in on first read, `notifyKeysChanged()` fires `owm:keys`; `apiPair()` writes the keyring itself. Two-way files: `owUploadFile()` (40MB limit, FileReader base64), `bytesToBase64()` (chunked, no stack overflow), `formatBytes()` (Intl vi-VN); `owDownload()` (fetch + Blob + % + AbortController + content-disposition fallback via the exported pure `filenameFromDisposition()`); `fileToBase64`/`MAX_UPLOAD_BYTES` are module-internal. **2026-10-03**: the orphaned helpers (`listKeys`, `renameKey`, `ensureActiveKeyEntry`, `inviteFromHash`, `apiPairTenant`, `apiMachineStatus`, `apiRevokeMachineKey`) were DELETED (grep-verified zero importers); the module is import-safe in bare Node (no storage side effects) and covered by 44 real tests in `web/test/` (4 files). **OpenWork desktop (same round)**: `apiWakeOpenWork()` used to throw away the bridge's `candidates` — it now keeps them on `error.candidates` (always an array, `[]` when the bridge omits it) so Settings can offer the same chooser on both paths. **`apiOpenWorkPath(path)`** POSTs `{path}` to **`/api/openwork/path`** — a BRIDGE route, so it calls `fetch()` **directly** and must never be wrapped in `ow()` (that prefixes `/api/ow`, the openwork-server proxy). It trims the path, sends `authHeaders({"content-type":"application/json"})`, maps 401 → `Error("UNPAIRED")` like its siblings, throws the bridge's own Vietnamese `message` verbatim (fallback ``path {status}`` for a non-JSON body) and returns the full payload so the caller can re-render from `openwork` without a second `/api/state` round trip. **2026-10-03 session block**: one private `oc(wsId, path)` builds `/workspace/:wsId/opencode…` and ten thin wrappers sit on top — `owAgents`, `owCommands`, `owQuestions`, `owReplyQuestion`, `owRejectQuestion`, `owRevert`, `owUnrevert`, `owFork`, `owDeleteMessage`, `owRunCommand`, `owTodo`. All were read out of the engine's live OpenAPI (`GET …/opencode/doc`) before being written; **every one already passes `bridge/src/proxy.js`'s whitelist**, which is why the whole feature set needed no backend change. |
| `src/app.jsx` | Hash router: `#/` (home — recent sessions across workspaces) · `#/workspaces` · `#/ws/:id` (sessions) · `#/ws/:id/chat/:sid` · `#/ws/:id/files` · `#/settings`. Topbar logo + version + **pinned Back button** per route (sessions → #/workspaces, chat/files → #/ws/:id; listens for `owm:topback` from FileViewer), StatusBanners (global OpenWork notices; **checks `state.error` FIRST and prints the actual network error instead of mislabeling it "Không tìm thấy openwork-server"**), floating BottomNav **3 tabs (Sessions · Workspace · Settings — English labels per the owner's call)** + FAB. Listens for the `owm:keys` event: re-checks `paired` (all keys gone → pairing page) and re-polls state. |
| `src/pages/home.jsx` | Home = recent sessions ACROSS workspaces (Happy/Omnara pattern), 15s poll, ws color dots (`wsColor`), FAB creates a session in the newest workspace. Creating a session sends NO title — the server names it from content, like desktop. **Swipe-to-delete**: same `SwipeRow` + `owDeleteSession(ws.id, session.id)` as the Sessions page (openId keyed `${ws.id}:${session.id}`). Tappable cards carry `role="button"`, `tabIndex={0}` and Enter/Space handlers. |
| `src/pages/pairing.jsx` | Connection page **9remote-style, two ways in (owner call 13/09 evening — "2 hàng: 1 mã tạm, 1 mã vĩnh viễn")**: row 1 = the 8-char pairing code (the hero, `.pair-code-input` 22px tabular-nums letterspaced uppercase, full-width 48px `.pair-btn`) typed from OpenPocket → `apiPair` → in; row 2 = the **permanent key** (`.pair-key-input` 16px mono, "hoặc" divider) — paste the master link `…#t=<key>&m=<room>` (the exe's "Sao chép link master" button) and it logs straight in, or paste a bare `owm_`/`owd_` key — a roomless key is REFUSED by the worker (400 `tenant_required`, no probing other people's machines), so the row has a **Phòng (room) box**: typing the room backfills the tenant for a bare key (normalized `[a-z0-9-]`), a full `#t=…&m=…` link still wins; roomless and box empty → the page shows the tenant_required hint naming the paths that still exist (the web detects the error KIND via `error.code` carried by `apiPair`). **`#p=CODE` links still pair by themselves** (the QR the GUI shows points here); the `#t=` master-token link auto-runs from `api.js`. Labels trimmed to one short line each (owner call). REMOVED earlier: the user/pass sign-in form and the `#i=` invite auto-login. |
| `src/pages/workspaces.jsx` | Card list with tile + add-workspace FAB; the create sheet (POST /workspaces/local) has a path field **+ a "Browse…" button opening `FolderPickerSheet`**: browse the computer's folders via `/api/fs/ls` (quick chips with real folder names (user/Desktop/Documents/Downloads/drives), go up a level, tap a folder to enter, **"+ New folder"** (POST `/api/fs/mkdir` then dive straight in), "Choose this folder" fills the path field). **create() sends `folderPath`** (it used to send `path` → the server rejected with "folderPath is required" — creating a workspace from the phone had never worked; the server mkdirs a missing folder itself). |
| `src/pages/sessions.jsx` | Session cards with busy/idle dot + new-session FAB (NO title sent — the server names it); back button moved up to the topbar; SSE live. **Swipe-to-delete**: each card is a `SwipeRow` — swipe left reveals the red "Xoá" button; tapping it calls `owDeleteSession(wsId, s.id)` (immediate, no confirm dialog), then `load()` drops the card (`session.deleted` SSE re-renders too). The hidden "Xoá" button is `tabindex="-1"` + `aria-hidden` while the row is closed. |
| `src/pages/chat.jsx` | Transcript (text/tool/reasoning; minimal markdown: code block/inline code/list — `MarkdownText`; reasoning is a collapsible `<details>`), composer with gradient send icon + **model picker (mandatory, bottom-sheet)** + **paperclip button to attach files** (uploads into `mobile-uploads/` then sends the prompt with the path), offline queue, permission cards (Allow/Deny), SSE events. Back button moved to the topbar. **Send morphs into Stop** (`busy = running && !sending`, `StopIcon`, red `.btn-send.stop`, double-tap guarded by `aborting`, draft kept, Ctrl+Enter while busy = abort). **Streaming keyed on `part.id`** (protocol learned from desktop `apps/app session-sync.ts`): `message.part.updated` = cumulative snapshot upserted per part, `message.part.delta` = append-only deltas buffered per partId and flushed once per animation frame (rAF, 50ms fallback), `message.updated` = whole-message upsert (empty parts never clobber an in-flight stream), `message.removed` prunes the bubble, `session.idle/errored/status` settle run status immediately; events arrive on the UNNAMED SSE line too — both paths funnel into one `handleEvent`; refetch only on mount/reconnect/visibility/watchdog(30s). **Files the agent mentions**: `findFileRefsInText()` scans text + tool input/output → `FileRefCard` renders a slim text row (icon + name + chevron, 28px) — tapping it verifies the file via `/files/stat` (**the engine answers 200 `{exists:false}` for a missing file, so read the `exists` flag instead of trusting "no throw"**; three candidate forms are tried because agent paths may carry a drive letter or a workspace-parent prefix) then deep-links into the Files viewer (`#/ws/:id/files?path=<dir>&open=<verified path>` — `FilesPage` auto-opens the viewer, and its text fetch checks `res.ok` so error JSON never renders as file content) + `linkifyFiles()` turns paths in text into links. **Queue honesty**: `modelBody()` reads a `modelRef` mirror (switching model mid-queue no longer sends the STALE model) and a persistent `.chat-status` line (single `aria-live="polite"`, `:empty` hidden) announces running + "Đang gửi lại n tin nhắn khi có mạng…". **2026-10-04 stale-model guard**: the chosen model is reconciled against the freshly fetched catalog (`resolveKnownModel`) right after `setModels`, and `isModelUsable` blocks the send outright when the remembered model no longer exists — see "Tin nhắn gửi đi không ai trả lời" above. **2026-10-03 session parity** (everything below runs through the existing proxy whitelist — no bridge change): `MessageBubble` opens a `MessageActionSheet` on tap (Copy / Sửa & gửi lại / Tạo nhánh mới / Hoàn tác / Xoá; the first two only when the message has text, the last three only for real `msg_` ids — a message still being sent has no server id yet); all mutating actions funnel through one `run(action, label, fn)` guard (single-flight, clears the sheet, reloads session+transcript+todo, Vietnamese error banner). `send()` reverts to the edited message BEFORE prompting. `AgentPicker` + `.cmd-pop` (type `/`), `QuestionCard` (multi-select + free text + reject), `.todo-row`, `.revert-bar` + `.editing-bar`. New state `revertId`/`cost`/`agents`/`agent`/`commands`/`questions`/`todos`/`editing`/`menu`/`busyAction`; `agentRef` mirrors `agent` for the offline queue exactly like `modelRef`. |
| `src/pages/files.jsx` | Browses `/opencode/file` (icon tiles, sizes via `Intl.NumberFormat` vi-VN); view/edit+save + upload via `/files/raw` (chunked base64 through the shared helper, per-file progress); image viewer (png/jpg/gif/webp/bmp/ico/svg/avif) + **inline PDF (iframe)**; downloads via `owDownload()` (fetch + Blob + % bar + Cancel + a Share button for iOS "Save to Files"). **2026-10-03 races/leaks**: the viewer's unmount cleanup mirrors the download state through `dlRef` (the old closure over first-render state never revoked finished blob URLs — a few large files and iOS Safari kills the tab) and a new download revokes the previous blob URL up front; `FilesPage.load()` bumps a `seq` counter + `AbortController` so a slower folder response can no longer overwrite the NEW breadcrumb with the OLD listing. File rows got `role="button"` + keyboard activation. |
| `src/lib/session-ops.js` | **Pure logic for ONE session** (added 2026-10-03) — deliberately framework-free so it is unit-testable, same pattern as `lib/chat-stream.js`. Holds the two rules that are easy to get backwards and were ported from OpenWork's `transcript-reconcile.ts`: `applyRevertCursor` / `hiddenCountByRevert` (the revert cursor is INCLUSIVE — the message you undo to and everything after it are hidden) and `resolveForkBoundaryId` (the engine copies messages *strictly before* `messageID`, so branching at a message means passing the NEXT one; synthetic client-side ids are skipped, `null` = fork everything). Plus `todoProgress`, `questionsForSession` / `questionView` / `buildQuestionAnswers` (the engine's `answers` contract: one array of labels per question, in order), `toolRowView` / `toolTitle` / `toolLabel` / `toolStatusVi`, `filterCommands`, `formatCost`. 15 tests in `web/test/session-ops.test.js`. |
| `src/lib/chat-scroll.js` | **Pure logic for CHAT SCROLLING** (added 2026-10-04), framework-free like every other lib. Holds the one decision the old inline code got wrong: `scrollPlan({forced, atBottom, changed})` → `"instant" \| "smooth" \| "hold"`. `forced` (the first render of a session) always returns `"instant"` **no matter how far the reader is from the bottom** — the old code measured the gap *after* the transcript rendered, so on entry (`scrollY` 0, tall document) it concluded the user was reading history and skipped the scroll entirely: a long session opened on its OLDEST message. It also stopped following a stream as soon as one block grew past the 260px threshold. Now "at bottom" is a passive `scroll` measurement taken *before* the next render. Also `distanceFromBottom` (clamped ≥0), `isAtBottom`, `newMessagesSince` (counts only messages appended by id — never part deltas, or the badge would flicker during streaming), `jumpLabelVi`, `shouldShowJump`. 14 tests in `web/test/chat-scroll.test.js`. |
| `src/lib/openwork-fix.js` | **Pure logic for the OpenWork path fixer** (added 2026-10-03), framework-free so `node --test` can reach it, same pattern as `lib/chat-stream.js`. Four exports: `mergeCandidates(...sources)` (empty/whitespace/non-string dropped, deduped, **first-seen order kept** — the bridge's best guess stays on top, and the old `new Set(...).filter(Boolean)` let a truthy object through and painted a "Dùng" row that would have posted `[object Object]` to the bridge), `openworkFoundOf(info, legacyFlag)` / `openworkRunningOf(info, legacyFlag)` (both accept the bridge's boolean OR the legacy field, and **return a boolean only when the signal really is one** — a missing field must never read as "running"), and `openworkStatusLabel(info, opts)` → `"đang chạy"` / `"đã cài, chưa mở"` / `""` (empty when not found, so the caller decides what "not found" reads as). `web/test/openwork-fix.test.js`, 11 tests. |
| `src/components/openwork-fix.jsx` | **The one OpenWork path chooser, rendered in two places** (2026-10-03): the global red banner in `app.jsx` and the Settings card. Before this, the complete fix lived 2 taps away in Settings while the banner that people actually hit — with its own wake button — **threw the `candidates` away on failure**, so the screen where the error appears had no way out and the screen with the way out was invisible. Contract: `onChoose` **must reject** when saving fails, or the component wipes the typed path after the bridge already refused it. |
| `src/pages/settings.jsx` | Bridge status table (connected machine, openwork-server, token, engine, public URL, bridge version), **Kiểm tra lại** (recheck — failures now surface in a `role="alert"` line instead of silently restoring the button), **Bật OpenWork trên máy tính** (remote wake), paired-devices card (list + revoke a phone's key), and **Gỡ pairing** = this phone forgets the machine (`removeKey()`; last key gone → back to the pairing page). **Removed 13/09 (one-PC simplification)**: the multi-machine keychain card and the Re-link card — one machine per phone now (the `api.js` keyring functions stay as internal plumbing used by `apiPair`/`removeKey`). **2026-10-03 — card "OpenWork trên máy tính" replaces the dead "OpenWork .exe" row** (that row was a verdict with no way out): `state.openwork` found → a 4-row table (**Tình trạng** "đang chạy" / "đã cài, chưa mở", Phiên bản `v0.18.54` / "không đọc được", Đường dẫn, Tìm ở đâu via `openworkSourceLabel()` = config / env / wellknown) + the hint pointing at the wake button; **not found → the fix**: the `candidates` list as one-tap "Dùng" rows + a `label.field` text input + "Chỉ đường dẫn", all funnelled through one `choosePath()` → `apiOpenWorkPath()`. Candidate sources are merged (state candidates + `error.candidates` from a failed wake, deduped) so the wake path and the state path agree. Success re-renders from `payload.openwork` (local `openworkOverride`, no refetch) and calls `onRecheck()`; failure shows the bridge's Vietnamese `message` **verbatim** in a `Banner`. Reuses only existing classes (`.card`, `.file-row`, `.name`, `.mono`, `.btn small`, `label.field`, `.sheet-body`) + inline `style` — **no `styles.css` change was needed**. **Same day, usability pass** (the first version was correct but fiddly): the chooser is no longer a one-way door — **"Đổi đường dẫn"** re-opens it while found (`editing` state, `showChooser = !found || editing`), because reinstalling OpenWork is ordinary and the old card was stuck at the first answer; **Enter submits** the field; a **"Quét lại máy tính"** button forces `/api/state` so "just installed it" doesn't mean staring at "chưa tìm thấy" for 15s; **"Chép đường dẫn"** (`navigator.clipboard`, plain text fallback); the chooser shows the File Explorer → right-click → Copy as path recipe, since that is the actual moment of confusion; success says the NEXT step ("bấm Bật OpenWork trên máy tính") instead of just "Đã chỉ xong"; a missing version explains itself (portable install, no `app.asar`, still fully usable). `openworkOverride` is **dropped on every `/api/state` tick** (`useEffect` on `state.openwork`) — without that it pinned the screen to a stale answer forever after any reinstall; `running` falls back to `state.server` when talking to a bridge that predates the field. |
| `public/sw.js` | App-shell precache (`CACHE = "owm-shell-v54"` — bumped in fe3830f to `v48` because the removed tab's precached index kept serving the old shell to installed PWAs; since bumped again with later UI passes) + navigate fallback; **precaches `/` (index.html) with `cache: "reload"` at install so the offline fallback truly serves the shell** (hashed Vite assets are runtime-cached on first load); never caches `/api/*`. Bump the version on every UI change so the PWA purges the old cache. |
| `public/_headers` | Same CSP as the worker for Cloudflare's asset-first path (Vite copies it to `web/dist`). |
| `public/icon*.png/svg` + manifest | Icons on `#111113` with a solid `#0090ff` stripe (matches the desktop logo) 192/512 + maskable (80% safe zone); manifest carries id/scope/lang/orientation/shortcuts. |

### desktop/ (OpenPocket.exe — native WinForms GUI, built by csc.exe with /codepage:65001, zero dependencies)

| File | Responsibility |
|---|---|
| `src/OpenPocket.cs` | C# 5 only (the framework csc can't parse newer syntax). **ONE page, ONE machine (user call 13/09 — "chỉ cần quản lý 1 PC, tính năng khác bỏ hết")**: OpenWork desktop's light language (#F4F4F5 bg, white rounded cards with hand-painted 1px borders via Region+GraphicsPath, BLACK primary buttons); 496×396 single column, ALL-WHITE full bleed, 8px spacing grid, `RoundedButton` kinds Primary/Ghost/DangerGhost on the skill-token palette (#1C2024 / #E4E7EC / #D3D8DE / #30A46C / #D64545), status rows with filled/hollow dots, an inline ↻ icon (borderless `InlineIcon`, calibrated against the "Cloudflare Tunnel:" label) that restarts the tunnel without touching the bridge, ADMIN badge as a painted pill with a fix-it tooltip. **Hardened 2026-10-03** (see its section above): `SafeInvoke` on every UI marshal, 10s `WaitForExit` on `schtasks`, WMI kill pinned to `bridgeDir\src\index.js`, `/run` exit-code MessageBox, poll slimmed (150ms probe, 32KB log tail), provisioning failures surfaced with retry. **Deps check, no runtime install**: `EnsureBridgeDepsPresent()` verifies `bridge\src\index.js` + `node.exe` + `bridge\node_modules` (vendored by the installer) with one MessageBox per missing piece — the old `EnsureBridgeInstalledAsync`/`bridgeNeedsInstall` machinery is DELETED. **Self-provisioning**: first run `BeginProvisionIfNeeded` POSTs `/api/tenant/create` with a random `pc-xxxxxxxx` room + `ows_` 48-hex secret (HttpWebRequest on a worker thread; `EnsureConfigDefaults` writes `lookupUrl`/`machineName` first, never overwriting existing values) so the QR works over the internet with zero typing; a machine that already has a config (the owner's) is untouched. **Close-to-tray**: X hides to a NotifyIcon, double-click restores, only the tray's 'Thoát hẳn' ends the process (and truncates logs — the bridge keeps running). **App icon**: the real OpenWork isometric mark, colors inverted, rasterized into `desktop/src/app.ico` (`/win32icon`), pulled back via `Icon.ExtractAssociatedIcon`. **QR dialog = the one feature**: renders the bridge's ASCII `qr`/`masterQr` (Consolas, white-on-black) + copy buttons; fetch starts on `Load` through SafeInvoke; `Relayout()` centers the code by its measured size and re-flows on every toggle. **Status card every 3.5s**: port TCP probe, machine identity/provisioning state, tunnel URL (or the 429-backoff message from `tunnel-state.json` — "Tự thử lại sau ~N phút — đừng restart bridge"), OpenWork desktop detection by the running `OpenWork.exe` process; Start refuses when already green; Stop = schtasks /end + pid file + WMI fallback + `WipeLogFiles(true)`; autostart checkbox writes a BOM-less `bridge-task.vbs` (`new UTF8Encoding(false)` — a BOM kills wscript silently) and is the ONLY creator of the scheduled task. **REMOVED 13/09**: the room join card, the Rooms tab, the invite-link paste and the worker-URL input — every login surface is gone. |
| `src/app.manifest` | `requireAdministrator` (UAC once — needed to manage the elevated bridge task and kill the elevated node) + Win8.1/10/11 supportedOS. **NO dpiAware on purpose**: the fixed-pixel layout doesn't scale, so per-monitor awareness = oversized text overlapping static boxes on HiDPI displays; DPI-unaware lets Windows scale the whole window uniformly. |
| `build.bat` + `build-setup.js` | csc compile → `bin/OpenPocket.exe`. **`/codepage:65001` is mandatory** — the source is UTF-8 without BOM and csc would otherwise read it as the ANSI codepage (mojibake on every Vietnamese label). `bin/` is gitignored: the exe embeds the real worker URL and binaries can't go through the pre-push washer — rebuild locally. **`build-setup.js` (node desktop/build-setup.js, `--stage-only` to stop after staging) rebuilds the ONE-FILE installer `OpenPocket-Setup.exe`** (asserts `web/dist` is not stale — newest mtime across `web/src` + `web/public` + `index.html` + `vite.config.js` + `package.json` must be ≤ the newest dist mtime, else it aborts with "rebuild first"; VENDORS the production `node_modules` closure walked from `bridge/package-lock.json` into the package, so the end user never runs npm install — see the Installer 2026-10-03 section; then embeds the package zip into the csc-compiled `src/OpenPocketSetup.cs` — see its row below). The exe is the ONLY artifact; gitignored; rebuild after every exe/HUONG-DAN change. |
| `src/OpenPocketSetup.cs` + `src/setup.manifest` | The INSTALLER source: a ~180-line WinForms app whose exe EMBEDS the package zip as a resource (build-setup.js passes `/res:openpocket-package.zip`; discovered at runtime by the `package.zip` suffix). On run: Node check (`where node.exe`) is a NON-BLOCKING Yes/No warning since the node_modules vendoring (2026-10-03) — install always proceeds, the dialog just offers to open nodejs.org (node.exe is still needed to RUN the bridge); progress window ("Đang cài OpenPocket…"), extracts the zip into `%LOCALAPPDATA%\OpenPocket` (ZipArchive in-place upgrade; an `IOException` while OpenPocket.exe is running → "đóng app rồi chạy Setup lại"), WScript.Shell shortcuts (Programs + Desktop, via `dynamic` COM — failures no longer swallowed: shortcut/launch errors are collected and shown in a "Đã cài xong, nhưng có việc chưa xong" warning box), then launches the app. asInvoker manifest — the setup stays non-elevated, the launched app asks its own UAC. `OPENPOCKET_TEST_DIR` redirects the target and skips shortcuts/launch for unattended testing. History: iexpress fails exit=1 SILENTLY on every SED variant (don't resurrect); a self-extracting .cmd (base64 zip + certutil) worked but a real .exe reads better for lowtech — the .cmd is retired. |

## The "symptom → where to fix" table

| Symptom | Where to fix |
|---|---|
| Session list looks huge, only a few sessions fit on screen | `web/src/styles.css` — `.card.tap.dense` (card density), `.fs-chips.scroll` (one-row filter chips). The inline `style="margin-top:6px"` on the card's second row in `pages/home.jsx` / `pages/sessions.jsx` must stay deleted or the gap ignores CSS. |
| Content sits under the bottom nav / the FAB covers the last card | The positioning constants live apart from the sizes: `.view` padding-bottom and `.fab` bottom in `web/src/styles.css`. Shrink or grow `.bottomnav` and these two must move with it. |
| A paired phone can read the **master token** out of `GET /api/pairing-code` | `bridge/src/routes/pairing.js` — `pairingCode({res, device})` adds `masterUrl`/`masterQr` only when `isMaster = !device` (app.js passes `device`; master ⇔ `null`). Device callers must **omit** the two keys entirely, never send `""`. Regression: `bridge/test/pairing-routes.test.js`. The web Settings card never rendered them anyway, so no UI change was needed |
| Web opened through the **tunnel** URL (or a self-hosted `publicUrl`) has no CSP / nosniff | `bridge/src/static.js` — `SECURITY_HEADERS` spread into the static `writeHead(200, …)`. The CSP string exists in **three** places that must stay identical: `static.js`, the `CSP` constant in `worker/src/index.js`, `web/public/_headers` (Pages). `bridge/test/static-headers.test.js` parses the worker array + `_headers` and fails if any directive drifts. Error branches (403/404/500) intentionally carry no headers |
| Strangers can flood the pairing rate limit (owner cannot pair a new phone while spammed) | `worker/src/index.js` — `POST /api/pair` **with a room** goes through `rateLimited(request, "pair", 10)` (429 `rate_limited`). It must stay at the worker: the bridge only ever sees `127.0.0.1` for every tunnel client, and the relay forwards client `x-forwarded-for` verbatim, so a bridge-side check is forgeable. The guard must stay **after** the tenant split so room-less requests still get `tenant_required`, not a 429. Regression: the two FIX-3 cases in `worker/test/relay.test.mjs` (11th attempt from one IP → 429 and no relay; room-less → 400 and a rate-limit counter that stays at 0) |
| Anyone knowing the worker URL can self-create rooms / two creates race for one name | `worker/src/index.js` — `env.ALLOW_ROOM_CREATE === "0"` → 403 `room_create_disabled` (line 274, before the body is read); unset or `"1"` keeps the door open exactly as before. **Both plans B and C landed**: after the `put`, the record is read back and compared with `sameSecret(secret, saved.secret)` (lines 318-321) — a stored secret that is not the one just written answers **409 `taken`** instead of `created`. That DETECTS the race, it does not prevent it (KV has no CAS; a real guard needs a Durable Object), and a read that comes back `null` stays 200 so KV's per-colo lag cannot cry wolf. Regression: the four FIX-4 cases in `worker/test/relay.test.mjs`. GUI provisioning (`desktop/src/OpenPocket.cs`) does **not** read that body: line 854 is `req.GetResponse()`, so a 403 throws a `WebException` and the catch at line 871 shows the raw .NET text ("The remote server returned an error: (403) Forbidden") in `provisionError` — the `room_create_disabled` code never reaches the GUI |
| Logs pile up / want the machine to keep no logs | `bridge/src/logwipe.js` — daily wipe at local midnight + boot-time cleanup of yesterday's logs; `openpocket stop` and the GUI Stop delete the files, GUI "Thoát hẳn" truncates (bridge still runs). Test with `openpocket logs` right after a stop: it should say "Chưa có log." |
| Bridge can't find openwork-server | `bridge/src/discovery.js` (parse engine-instances, netstat, health probe) |
| Owner token 401 despite the restart | `bridge/src/bootstrap.js` + check the `openwork-mobile-bridge` entry is still in `%APPDATA%\openwork\tokens.json` |
| Every write returns `policy_unavailable` "Sign in to verify..." | NOT a bridge bug — open OpenWork desktop and sign in/verify (cloud session expires after a restart) |
| Prompt sent, message hangs, no reply | Missing `model: {providerID, modelID}` in the body — see `web/src/pages/chat.jsx` (`modelBody()`); the engine demands an explicit model |
| The agent asked a question and the phone shows nothing / the run just stops | `GET /workspace/:id/opencode/question` was never polled. `web/src/pages/chat.jsx` (`loadQuestions` + `QuestionCard`) and `web/src/lib/session-ops.js` (`questionsForSession`, `questionView`, `buildQuestionAnswers`) |
| "Hoàn tác" hides the wrong messages / fork loses the message you tapped | `web/src/lib/session-ops.js` — `applyRevertCursor` cuts from the cursor **inclusive**, `resolveForkBoundaryId` must pass the **next** message id because the engine copies strictly *before* `messageID`. Both ported from `apps/app/src/react-app/domains/session/sync/transcript-reconcile.ts` and regression-tested in `web/test/session-ops.test.js` |
| Editing a sent message appends a second copy instead of replacing it | `web/src/pages/chat.jsx` `send()` — the edit path must `revert` to the edited message BEFORE prompting, otherwise the old turn stays and the new one is appended after it |
| A tool row shows a wall of raw JSON / a title too long to fit | `web/src/lib/session-ops.js` (`toolRowView`, `toolTitle`) — engine `state.title` for `bash` is the full command; prefer the tool-specific input field |
| Web API call 403 "Path not allowed" | `bridge/src/proxy.js` — the `ALLOWED` array (add the new openwork-server path prefix) |
| POST with a body hangs through the bridge | `bridge/src/proxy.js` (the body must be buffered, not streamed; abort only when `res` closes + `!writableEnded` — `req` 'close' also fires for normally finished requests) |
| SSE doesn't stream / keeps dropping | `bridge/src/proxy.js` (isSSE + keepalive) + `index.js` (`server.requestTimeout = 0`) |
| Opening a long session shows the OLDEST message, and scrolling up through history has no way back | `web/src/lib/chat-scroll.js` + `web/src/pages/chat.jsx` — the old auto-scroll measured "distance to bottom" *after* the transcript rendered, so on entry (`scrollY` 0, tall document) it always decided the user was reading history and skipped the scroll. `scrollPlan()` now forces the first real transcript of a session to the bottom, `keepsAutoScroll()`/`leftBottomBy()` keep the app's own scrolls from being read as a user swipe-up, and a `.jump-latest` pill ("Tin mới nhất" / "N tin mới") appears whenever the reader is up in history. **The QA round in the section above is mandatory reading before touching this** — the first version of the fix passed its own tests and still killed auto-follow mid-message |
| Forking a session (or switching chat→chat) can show the PARENT session's messages under the child's title | `web/src/pages/chat.jsx` — `ChatPage` is rendered unkeyed, so `run()`'s post-action reload ran with the previous session's closure and a late response overwrote the new transcript (also consuming the jump-to-bottom flag). Every loader now captures `sessionId` and bails if it changed while in flight; `loadPermissions` matters most — a stale card means tapping Allow/Deny answers the wrong agent |
| Chat view jumps back up while scrolling during a run | `web/src/pages/chat.jsx` (`loadMessages`) + `web/src/lib/chat-stream.js` (`mergeRefetchKeepInflight`) — the transcript API only flushes FINISHED messages, so a mid-run full refetch (SSE reconnect, tab return, 30 s watchdog) used to drop the still-streaming message: the page shrank and the browser clamped the scroll position (felt like being thrown back up, then the text grew back). Mid-run refetches now merge, keeping local messages the machine hasn't persisted yet. Regression: `mergeRefetchKeepInflight` tests in `web/test/chat-stream.test.js` |
| Phone can't pair | `bridge/src/auth.js` + the token in `%APPDATA%\openwork-bridge\config.json`; the QR prints at bridge startup |
| Wrong workspace list | openwork-server's side; check `%APPDATA%\openwork\server.json` |
| Creating a workspace requires typing a path / want to tweak the folder browser | `bridge/src/fslist.js` (listing + mkdir) + `bridge/src/index.js` (routes `/api/fs/ls`, `/api/fs/mkdir`) + `web/src/pages/workspaces.jsx` (`FolderPickerSheet`) |
| Creating a workspace from the phone says "folderPath is required" | `web/src/pages/workspaces.jsx` `create()` must send `{folderPath}` (the server's exact demanded key) — NOT `{path}` |
| Blank web page / won't load | Rebuild `web/` (`npm run build`) — the bridge serves `web/dist` via `bridge/src/static.js` |
| Want different colors/vibes | `web/src/styles.css` (`:root` tokens) + sync `.zcode/skills/pwa-workspace-ui/references/tokens.md` |
| UI feels "cold" / buttons snap instantly, no motion at all | `web/src/styles.css` motion tokens (`--dur-tap/--dur-ui/--dur-move/--dur-spin/--dur-shimmer/--dur-pulse/--ease`). Every transition must use them — a literal `0.2s` in the CSS is a leftover. `button.btn` animates `transform/filter/opacity` only (never `width/height/margin`, which thrash layout) and `:active` presses to `scale(0.97)` |
| Want guidance on what to DO to make a page look good, not just what is forbidden | `.zcode/skills/ui-dep/SKILL.md` — positive playbook (style layering, do-this table for 10 surfaces, motion values, microcopy). Drop-in CSS in `ui-dep/recipes.css` |
| Want the standard UX rule for one specific situation | `.zcode/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain ux` (offline, 119 rules). **Read `ui-ux-pro-max/OPENWORK.md` first** — its generated palette and Google Fonts contradict this project's hard rules |
| Buttons hidden under the notch/home indicator | Safe-area: `--sat/--sab` in `web/src/styles.css` (topbar, bottomnav-wrap, FAB, composer) |
| Inputs zoom on focus on iPhone | Field font-size < 16px — check `web/src/styles.css` (every input/textarea/select must be ≥16px) |
| Tunnel won't come up / public URL won't open | `bridge/src/tunnel.js` (download cloudflared, parse URL from log). Log keeps saying "429 - chờ 120s/240s/...": Cloudflare rate-limits Quick Tunnel provisioning **per IP** — caused by restarting the bridge/cloudflared too often (each restart = a new provisioning request); **don't restart anything, let the 120s→10 min backoff run quietly** and the block lifts by itself (verified 13/09). URL registers then dies in <1 min with `cloudflared thoát (code 4294967295)`: the edge dumps a fresh tunnel from a flagged IP — now also backoffed long (same fix); if it recurs, check who kills cloudflared (9router only kills its own port 20128, Defender history: `Get-MpThreat`). **v3.3**: cloudflared runs `--protocol http2 --edge-ip-version 4` now (the QUIC/UDP death loop fed the limit) and the backoff survives restarts (`tunnel-state.json`) — a bridge restart during a 429 no longer resets the wait; `openpocket status` and the GUI show the remaining minutes |
| Worker returns 503 "bridge_offline" / "bridge_unreachable" | The bridge hasn't heartbeated for >20 minutes (machine off?) or the tunnel just changed — wait ~15-30s for `src/lookup.js` to re-register. No tenant: the worker's `BRIDGE_SECRET` must match `lookupSecret` in the bridge config; with a tenant: `lookupSecret` must match the secret in KV `tenant:<user>`. **v3.3**: while the bridge is alive but the tunnel is down it returns **503 `tunnel_down`** with the retry ETA instead (and CF edge 5xx become clean `tunnel_down` 502s), so "offline" now really means the machine/bridge is gone |
| Typing the 8-char pairing code by hand fails with 400 "tenant_required" while scanning the QR works | Expected now: a typed code carries no room id (only the QR link has `&m=`) and the worker REFUSES roomless bootstrap calls instead of fanning the code out to every live machine — `worker/src/index.js` answers **400 `tenant_required`** with a message naming the paths that still exist (message reworded 2026-10-03: the sign-in UI is gone). Scan the QR / open the full link (always carries `&m=`) — or paste a bare key and type the room in the Phòng box |
| Phone stuck "offline" forever after its room was deleted from KV (e.g. the marcus cleanup), no way out inside the app | `relay()` in `worker/src/index.js` returned 503 "bridge_offline" for a missing machine slot — forever, and the app has no un-pair UI for that case. Now a missing slot + missing `tenant:<id>` record returns **401 `unpaired`**, which the app already maps to "UNPAIRED" → back to the pairing page; scan the QR once and you're in. A missing slot with the room still in KV (bridge mid-restart) stays 503 — transient, no re-pairing needed |
| Pasting a bare permanent key (`owm_…`) into the second row can't find the machine | A bare key carries no room id, same as a typed 8-char code — the worker refuses roomless `GET /api/state` with **400 `tenant_required`** (no probing other people's machines). `web/src/pages/pairing.jsx` catches that error code and shows the hint; the row's **Phòng box** (2026-10-03) lets you type the room and log straight in. The master LINK from the exe already carries `&m=`, so it never needs the room box |
| `/api/pair/tenant` answers 404 "not_joined" | The route works only when the bridge config carries `lookupTenant` + `lookupSecret` — i.e. the machine joined a room. The desktop GUI provisions that silently via `POST /api/tenant/create` on first run; there is no `openpocket edge join` anymore (removed 13/09). No UI calls this route today — it is dormant API surface |
| Room sign-in returns 401 despite the right password | The worker compares the secret against KV `tenant:<user>` BEFORE relaying — 401 means (unknown user OR wrong pass), no room existence leaks. Right pass but persistent 401: check the KV JSON is intact (`npx wrangler kv key get tenant:<user> --remote` — cmd Windows once swallowed the quotes when the old script went through a shell; fixed by calling wrangler directly via node, as `scripts/tenant.mjs` does now) |
| Sign-in / room creation returns 429 "quá nhiều lần" | Deliberate: the worker rate-limits the open doors via the Cache API (`rateLimited(request, kind, limit)` in `worker/src/index.js`): sign-in 10/min/IP, room creation 5/min/IP — protects passwords from guessing AND the free KV read quota from being burned; wait ~1 minute and retry |
| One person's phone sees another's machine data (must never happen) | Check `x-owm-tenant` is attached everywhere (`web/src/api.js` — `authHeaders()`/`tenantHeaders()`) and the worker picks the right slot (`worker/src/index.js` — `x-owm-tenant` header / `?_m=` / `machine:main`); the worker holds no keys, so a wrong room can only be a missing/wrong tenant. Each `owd_` key exists as a hash only in the `devices.json` of the machine that minted it |
| The pairing key shows up in browser history / in a proxy's access log | Nothing may put a credential on a URL. `web/src/api.js` authenticates every request with the `Authorization` header. Anything a browser fetches on its own (`<img>`, `<iframe>`) goes through `blobUrlFor()` → `blob:` object URL (`web/src/lib/blob-cache.js`). Markdown file links point at the app's own Files route, not a raw URL. `sseUrl()` — the old `?_t=` builder — is deleted; `grep -n '_t=' web/src` must return only comments. If a new surface needs a URL the browser will load by itself, use `blobUrlFor`, never a query token |
| Through the worker the response turns into garbage chars / broken curl bodies | The CF edge compressed the tunnel response — fixed in the `worker/src/index.js` relay: subrequests ask `accept-encoding: identity` + unwrap `content-encoding: gzip/deflate` via `DecompressionStream`; if it recurs, check these two spots |
| Phone loses connection after a machine restart | **No longer a problem** (the worker re-finds the bridge via heartbeat). If truly lost: free Workers quota (100k/day) or the bridge isn't running |
| OpenWork update changes data formats | Adapters isolated: `discovery.js` (engine-instances.json), `bootstrap.js` (tokens.json) |
| New sessions all named "Mobile" | `web/src/pages/home.jsx` + `sessions.jsx` (`newSession()`) used to hardcode `title: "Mobile"` — removed; session creation sends an empty body `{}` so the server names it |
| Download button / images return 401 with the master token | `bridge/src/index.js` once called `isAuthorized()` (header-only) even though `requestToken()` extracts `?_t=` — fixed to `isTokenAuthorized(token, ...)` accepting both; test `?_t= query token counts as master token` in `bridge/test/auth.test.js`. The web no longer relies on that path (see the credential-on-URL row above) |
| A file link in chat opens the viewer and says "File not found" although the file exists | The agent usually names a file relative to a subdirectory (`README.md`) while the real path is deeper (`projects/toolkit/README.md`). `web/src/pages/files.jsx` probes `files/stat` for alternate path shapes before giving up. This is not a token problem — a raw URL to the same wrong path 404s identically |
| The whole Files page renders blank (no list, no breadcrumb) | A hook reading a `useState` value declared *below* it throws `ReferenceError: Cannot access 'X' before initialization` at mount and takes the view with it. Declared order in the component body is load-bearing; `npm run build` does not catch this |
| Large uploads hang / crash the app | `files.jsx` once used `btoa(String.fromCharCode(...spread))` → stack overflow — replaced with `fileToBase64()` (FileReader) + chunked `bytesToBase64()` in `web/src/api.js`; explicit `MAX_UPLOAD_BYTES` 40MB (base64 inflates ~37%, proxy caps 64MB) |
| Want to receive files the agent created without digging in the Files tab | The engine has no dedicated file part — the agent writes via the `write` tool then mentions the path in text. `chat.jsx` (`findFileRefsInText` + `FileRefCard` + `linkifyFiles`) shows slim text rows in the message — tapping one opens the file straight in the Files viewer (view/download) |
| Want to send a file/image from the phone to the agent | The paperclip in the `chat.jsx` composer: uploads into `mobile-uploads/` via `owUploadFile()` then sends the prompt with the path (the engine takes no file part) |
| Downloads show no % / no resume | `bridge/src/proxy.js` used to forward only 5 headers — added `content-length/content-range/accept-ranges` |
| Bấm "Cho phép" xong agent vẫn đứng ở bước xin phép | Body sai tên field: web gửi `{response:"allow"|"deny"}`, engine nhận `{reply:"once"|"always"|"reject"}` và bỏ qua field lạ. `web/src/lib/session-steer.js` (`permissionReplyBody`) + `chat.jsx` |
| Nút Dừng kẹt sau khi lượt chạy xong | `sessionBusyFromMap` trả `undefined` cho map rỗng nên caller giữ `running=true`. Engine chỉ liệt kê phiên đang chạy → vắng mặt là rảnh (`false`); `undefined` chỉ dành cho "đọc hỏng"/shape lạ. `web/src/lib/session-steer.js` |
| Nén hội thoại bị báo hết thời gian chờ giữa chừng | `owSummarize` + `owRunCommand` nay `timeoutMs: 0` — engine cũng miễn timeout cho `/summarize` và `/command` (opencode.ts) |
| Tin vừa gửi biến mất khi mở lại app / SSE reconnect | `mergeRefetchKeepInflight` trong `web/src/lib/chat-stream.js`: chỉ tin MỚI trong `fetched` mới xác nhận được tin chờ (`prevIds` lọc trước khi đếm theo nội dung) |
| Upload 5–40MB luôn hỏng dù báo "giới hạn 40 MB" | `MAX_UPLOAD_BYTES` lấy đúng `FILE_SESSION_MAX_FILE_BYTES = 5.000.000` của engine (`web/src/api.js`) |
| Hash/QR cắt ngang làm app trắng màn | `decodeURIComponent` trên `location.hash` ném `URIError` lúc import module. `web/src/lib/route.js` (`safeDecode`), dùng ở `app.jsx` + `files.jsx` |
| Chat đứng im sau vài tin (stream không vào) | Parser SSE cũ lọc `startsWith("data: ")` nên rơi frame không có space. `web/src/lib/sse.js` viết lại theo spec, `takeFrame` export ra test |
| Tin gửi đi không ai trả lời (engine nhận + lưu message, không chạy, không báo lỗi) | Model trong `localStorage.owm_model` không còn trong catalog của engine — guard `owm_agent` có nhưng `owm_model` thì không. `web/src/lib/model-behavior.js` (`resolveKnownModel` + `isModelUsable`) + `chat.jsx` (đối chiếu sau `setModels`, chặn ở `flushQueue`); test trong `web/test/model-behavior.test.js` |
| `.xlsx`/`.docx` link opens a blank page instead of downloading | `bridge/src/proxy.js` (`shouldForceDownload` + `rawPathOf`): the engine answers `inline` on `/files/raw` and the old fallback regex matched the query string, so it never fired — now the path is matched query-free and office/archive/binary extensions get `attachment`. Images/PDF/media stay `inline`. Real-HTTP proof in `bridge/test/proxy-download.test.js` |
| iOS download opens in a tab instead of saving / no progress on big files | `web/src/api.js` (`owDownload()`: fetch with auth header + stream read for % + AbortController) + `files.jsx` (Blob download + progress bar + Cancel + Share via `navigator.share` for iOS "Save to Files") + `bridge/src/proxy.js` (adds a `content-disposition: attachment` fallback from `?path=` when upstream forgets); test in `bridge/test/bridge.test.js` + `filenameFromDisposition` in `web/test/api-contract.test.js` |
| Back buttons drift with content while scrolling | `web/src/app.jsx` + `web/src/styles.css` — the Back buttons live on the `topbar` (sticky at the top, with blur and safe-area). FileViewer borrows the topbar via the `owm:topback` event |
| Changed web code but the phone still shows the old version | Build `npm run build` in `web/` then deploy the only worker: `cd worker && npx wrangler deploy` (the official `openpocket` worker — it serves the web assets too; there is no secondary worker anymore). Bump `CACHE = "owm-shell-v54"` in `web/public/sw.js` so the PWA purges the old cache |
| Bridge doesn't auto-start at Windows login | `openpocket autostart --enable [--with-openwork]` creates the `OpenPocketBridge` task (ONLOGON, **/RL HIGHEST = admin**) in Task Scheduler — see `bridge/src/autostart.js` + `bridge/bin/openpocket.js`. The task runs a **hidden VBS wrapper** (`%APPDATA%\openwork-bridge\bridge-task.vbs` → logs to `bridge-task.log`, `openpocket logs` auto-picks the freshest file) — running node directly would pop a console window and die the moment someone closes it. Needs admin once (UAC); check with `--status`. Admin is required so phone input reaches apps running as Administrator (UIPI blocks normal→elevated input); UAC prompts/lock screen stay unreachable (secure desktop) |
| Bridge died silently hours ago and nobody noticed (worker 503 for hours) | Happened for real 13/09 (~08:03, cause unknown — process vanished, err.log empty). Cure: `openpocket watchdog --install` (admin once) → every 5 min `openpocket ensure` revives a dead bridge and never duplicates a live one; `watchdog.log` keeps the revive history. Diagnose the death itself: last lines of `%APPDATA%\openwork-bridge\bridge.log` + `tasklist` + Event Viewer (externally-killed processes often leave no trace) |
| Two starts crash with EADDRINUSE: 127.0.0.1:8788 already in use | Since 13/09 the bridge writes `bridge.pid` itself (any start path) and `start`/`ensure` probe the port before spawning; an outside-CLI instance holding the port is left alone (`openpocket status` says "instance ngoài CLI"); the listener itself retries ten times, 400ms apart (`bridge/test/listener.test.js`). To kill a stale one: `netstat -ano | findstr 8788` → PID → taskkill |
| Phone reports the server missing while OpenWork isn't open | Tap "Launch OpenWork on the computer" (red banner + Settings) → `POST /api/openwork/wake` → `bridge/src/openwork-launch.js` finds the exe and opens the app. Exe not found → **don't hand-edit `config.json` anymore**: Settings → "OpenWork trên máy tính" lists the well-known candidates as one-tap buttons + a field for any other path → `POST /api/openwork/path` (must be a file named exactly `OpenWork.exe`). A powered-off/deep-sleeping machine can't be woken — turn it on first |
| "Mở từ xa" báo lỗi dù đã chỉ đường dẫn | The route only accepts a file literally named `OpenWork.exe` — it exists to keep a phone-typed path from ever reaching the `spawn()` in wake/auto-launch, so any other executable is refused on purpose. Copy/rename the real OpenWork.exe, or point at the installed one under `%LOCALAPPDATA%\Programs\@openworkdesktop\` |
| Phone doesn't show which OpenWork version the computer runs | `GET /api/state` carries `openwork: {found, exe, version, source, running, candidates}` (version parsed from the installed app's `resources/app.asar`; `""` = "không đọc được", which is the honest answer when the asar is missing/corrupt — there is no PowerShell fallback by design, see `src/openwork-version.js`). `running` = the desktop process actually alive, not just an entry in `engine-instances.json` |
| Pasted exe path is rejected with "not_found" even though the file is right | You copied it from PowerShell / CMD, which wraps it in quotes. `normalizeExePathInput()` strips them now; historically nothing did, so `"C:\...\OpenWork.exe"` pasted verbatim never matched a real file (and its basename `"OpenWork.exe"` failed the name guard too) |
| Settings says "chưa tìm thấy" right after installing OpenWork | The card polls with `/api/state` (15s) — tap **"Quét lại máy tính"** in the card to force it instead of waiting |
| The red banner says OpenWork is missing and there is nothing to do about it | It used to be a dead end: the banner's own "Bật OpenWork trên máy tính" button received `candidates` from the bridge on failure and **discarded them**, while the working chooser sat two taps away in Settings. Both now render the same `<OpenWorkFix>` (`web/src/components/openwork-fix.jsx`), and the chooser appears inline under the banner as soon as the bridge suggests paths and no exe is found — no navigation needed. Both call sites must go through `mergeCandidates()` so a second failed wake can never erase the candidates the first one produced |
| OpenWork chooser clears what you typed after a rejected path | `onChoose` has to **rethrow**: `choosePath()`/`chooseExePath()` re-throw on HTTP failure *and* on HTTP 200 with `openwork.found === false` (the bridge stores the path but still can't see the file — real, it happens when reading the version throws). Swallowing either case resolves the promise and the component treats it as success, wiping the field the user must retype |
| Want the Send button to interrupt the agent like ChatGPT/Gemini | `chat.jsx` — Send morphs into a red Stop button (`busy = running && !sending`) while the agent runs; tapping again calls `abort()`, the draft is kept |
| Chat sits frozen; must leave and re-enter to see new messages | Old behavior: exact `data.sessionID === sessionId` SSE filter, no fallback. Fixed: stream-patch per `part.id` (`applyStreamingPatch` + rAF delta flush), 30s watchdog + refetch on SSE error/app reopen/network back — see the `chat.jsx` row |
| A file mentioned in chat renders as a boxed card with buttons, and tapping it kept landing on "file not found" (or the error JSON showed up AS the file content) | `web/src/pages/chat.jsx` `FileRefCard` + `web/src/pages/files.jsx`. The card is now a text-only `.file-row` (ZCode style, 28px) — tapping it tries three path candidates against `/files/stat` (the engine answers 200 `{exists:false}` when the file is missing, so the `exists` flag must be read) and deep-links `#/ws/:id/files?path=<dir>&open=<verified path>`; `FilesPage` auto-opens the viewer for `?open=`, and the viewer's text fetch checks `res.ok` so error JSON never renders as content |
| Settings' "Kiểm tra lại" silently swallows a dead tunnel / 401 | Fixed 2026-10-03 (`fe3830f`): `recheck()` had `try/finally` with no `catch` — it now surfaces "Kiểm tra lỗi: …" (UNPAIRED rendered as "chìa hết hiệu lực") in a `role="alert"` line |
| The app banner says "Không tìm thấy openwork-server" on any network hiccup | Fixed 2026-10-03: `app.jsx` `StatusBanners` reads `state.error` FIRST and prints the actual error (a healthy `/api/state` payload never carries an `error` field, so the branch can't misfire) |
| Chat queue sent the prompt with a STALE model after switching models offline | Fixed 2026-10-03: `modelBody()` reads a `modelRef` mirror instead of the effect-scoped `model` state; queued sends are announced by the persistent `.chat-status` line |
| Downloaded files slowly leak blob URLs (iOS Safari kills the tab) | Fixed 2026-10-03: `FileViewer`'s cleanup mirrors the download state through `dlRef`; a new download revokes the previous blob URL up front |
| Two quick folder taps in Files show the OLD folder under the NEW breadcrumb | Fixed 2026-10-03: `FilesPage.load()` bumps a `seq` counter and aborts the previous fetch via `AbortController` — stale responses return without touching state |
| Text in the desktop QR dialog is nearly invisible (white-ish on white) | Dark-era palette leftover: `PairingQrDialog.ColorText` was #F4F4F5 (near-white) — on the light theme that made the title, the unselected "Mã vĩnh viễn" toggle, the master link and Đóng almost unreadable. Rule: **every Form's text constant must match its own background** (flipped to #18181B), and a selected/unselected toggle must swap ForeColor WITH BackColor (`ShowQr` in `desktop/src/OpenPocket.cs`). Caught by eye 13/09 |
| QR in the desktop pairing dialog sits off-center with a big empty band under it | The AutoSize ASCII-QR label was pinned at x=95 and the link/copy block pinned at y=496 — but the QR's real width AND height differ between the 30-min and master codes, so nothing matched. Fixed with `Relayout()` in `desktop/src/OpenPocket.cs`: center the label by its measured width, stack the lower block from the QR's actual bottom, shrink/grow the dialog to fit (called from ctor + `ShowQr` so both tabs re-flow). Verified live with a throwaway harness that opens only `PairingQrDialog` against the running bridge. Caught by eye 13/09 |
| Tunnel sits in a 429 backoff countdown even though the IP already changed (router reboot) — the wait feels "hit-or-miss" | `tunnel-state.json` counts 429s, not IP changes — the persisted `nextAttemptAt` keeps the old wait. Owner call night 13/09: manual restart wins. `restart()` in `bridge/src/tunnel.js` (cancels the pending timer, zeroes the streak, kills cloudflared, respawns once) exposed as `POST /api/tunnel/restart` and the GUI's inline ↻ icon; Cloudflare still counting → it 429s again and the normal backoff resumes on its own |
| Main OpenPocket window has a dead empty column on the right / overlapping status text on HiDPI | Two layout traps fixed 13/09: the window is now 496px wide measured from content with `RelayoutContent()` re-spanning rows on resize; and `app.manifest` must NOT declare dpiAware — the fixed-pixel WinForms layout doesn't scale, so per-monitor awareness renders oversized text over static boxes (Windows bitmap-scales a DPI-unaware window correctly). Also: WinForms docks child controls by DESCENDING index — the Fill panel must sit at index 0 (`SetChildIndex` at the end of `InitializeComponent`) |
| Quitting OpenPocket from the tray crashes with ObjectDisposedException | Fixed 2026-10-03: every UI marshal goes through `MainForm.SafeInvoke` (disposed-guard + dispose-race swallow) — see the GUI hardening table above |
| Task says "Running" but the bridge never boots; cscript/wscript on `bridge-task.vbs` errors "Not enough memory resources are available" | The .vbs carried a **UTF-8 BOM** (EF BB BF) — the VBScript host dies instantly on it and `schtasks /run` still reports SUCCESS, so every logon/restart attempt silently did nothing (caught 13/09 after a tool rewrite of the vbs). Fix: write the vbs BOM-less (ASCII bytes). **`desktop/src/OpenPocket.cs` `EnsureAutostartTaskEnabled` must keep `new UTF8Encoding(false)`** — plain `Encoding.UTF8` in .NET `WriteAllText` re-adds the BOM |
| The machine silently leaves its room: bridge runs, log shows no "[lookup] reporting tới" after a boot, phone says the room has no machine | `%APPDATA%\openwork-bridge\config.json` was rewritten with EMPTY `lookupUrl/lookupTenant/lookupSecret` (parallel sessions testing CLI/config — documented footgun, happened twice on 13/09). Repair: read the room secret back from KV (`npx wrangler kv key get tenant:<user> --remote` — owner machine), re-patch those keys in config.json, then restart the task. The GUI's status card exposes exactly this state (room line + tunnel line go quiet) |
| `git push` ends with "failed to push some refs" right after a 🔒 washer message | INTENTIONAL — the pre-push hook (machine-local `.githooks/pre-push`) already published the sanitized mirror; the raw push is always cancelled so originals never leave the machine (see README "Publishing & privacy"). Gate blocked with 🛑 = a personal string survived the wash; the hook prints the offending file list (fix the file, or add the pattern to `$WASH_SED` + `$WASH_GREP` in the hook). Verify without pushing: `WASHER_DRYRUN=1 sh .githooks/pre-push origin main main` |
| Personal data reaches GitHub even though the washer "passed" | Three ways this used to happen, all now closed in `.githooks/pre-push` (2026-10-04): (1) the tree-filter washed a hand-listed set of 8 files, so any personal string in a 9th file went out untouched — it now washes **every** text file in every commit (`grep -rIl` selects them); (2) the wash and the safety gate were **case-sensitive**, so a real Gmail address written with a capital first letter passed a gate that only looked for the lowercase account name — both are now `sed -E …/gI` + `grep -iE`; (3) the Cloudflare KV namespace id was never in any pattern list, so it is published in all 149 commits that touch it — a 32-hex id → all zeros. Two more traps: an `s|…(a|b)…|` sed expression breaks because `|` is the delimiter (use `#`), and `$VAR` inside a `case` pattern is NOT field-split, so the extension list matched nothing and silently washed zero files. Note `.wrangler` caches (which hold the Cloudflare account record) are deleted from every commit |
| A test fixture or log path leaks `C:\Users\<your name>` | Wash patterns only cover what was listed. Keep fixtures generic (`C:SERS<USER>\…`) instead of the real account name — it is not worth a history rewrite later. Current rule lives in `$WASH_SED` in `.githooks/pre-push` |
| Deployed web suddenly refuses to run scripts / console says "Refused to … Content Security Policy" | The worker's CSP (`withSecurityHeaders` in `worker/src/index.js`): scripts must be same-origin files (NO inline `<script>`), styles may be inline, `img-src` allows `data:`/`blob:` (file previews are object URLs). Loosen the directives there if the web ever gains a CDN script or an iframe |
| Phone can't find the PC after bridge restarts (worker says machine offline), bridge log repeats `đăng ký lỗi HTTP 401` | Tunnel registration secret mismatch: worker env `BRIDGE_SECRET` ≠ home bridge config `lookupSecret`. Fix: `wrangler secret put BRIDGE_SECRET` with the config value (worker path: `cd worker`, value from the bridge's config.json). The tunnel URL itself changes on every bridge restart — registration is what repoints `machine:main` |
| Workspace cards all look the same / color only on the dot | `styles.css` `.ws-card` + `.ws-card .tile` read `--ws-c`, set inline in `workspaces.jsx` from `wsColor(ws.id)` (`home.jsx` exports it); chips tint the border via `.ws-chip` |
| Desktop GUI (or any child node process) shows mojibake Vietnamese text | Encoding, two spots: `desktop/build.bat` must pass `/codepage:65001` (source is UTF-8 without BOM — csc otherwise reads it as ANSI and every Vietnamese label garbles) and every node ProcessStartInfo in `desktop/src/OpenPocket.cs` must set `StandardOutputEncoding = UTF8` — tool output with em-dashes (`—`) mojibakes under the ANSI codepage and regex parsing silently matches nothing |

## Bridge API routes (called by the phone)

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/state` | owm_/owd_ | Bridge + server + token + engine status, current device + `edge: {tenant, machineName}`, **OpenWork desktop `{openwork: {found, exe, version, source, running, candidates}, openworkExeFound}`** (`candidates` are sent **always**, not only when not found — the phone needs a way in to CHANGE a path as much as to find one; `running` is the desktop process alive, not just a registry entry; the legacy boolean stays in the contract) |
| `POST /api/pair` | **none** (rate-limit 10/min/IP) | Pair a device with the 30-minute code → returns the permanent owd_ key |
| `POST /api/pair/tenant` | **none** (shared rate-limit, 10/min/IP) | Multi-tenant sign-in: body `{user, secret, label}` — compared against `lookupTenant`/`lookupSecret` in config → returns `{token, device, tenant, machineName}`. Not joined → 404 `not_joined`; wrong → 401 `invalid_credentials` |
| `GET /api/pairing-code` | owm_/owd_ | Live one-time code: `codeFormatted` + `secondsLeft` + `baseUrl` + **`pairUrl`/`qr`** + **`masterUrl`/`masterQr` ONLY when the caller is the master** (ASCII QR rendered by qrcode-terminal ON the bridge — CLI `openpocket code` and the desktop GUI authenticate with `config.mobileToken` and display them; the code never touches a third-party QR service. A **device key gets neither field** — see the 2026-10-04 security round) |
| `GET /api/devices` · `DELETE /api/devices/:id` | owm_/owd_ | Paired devices list + revoke |
| `POST /api/recheck` | owm_ | Force discovery |
| `POST /api/tunnel/restart` | owm_/owd_ | Manual tunnel restart — cancels the 429 backoff wait and asks Cloudflare for a fresh tunnel NOW (bridge stays up, only cloudflared is replaced; new URL re-registers itself). 409 `tunnel_inactive` when the tunnel is off (`OPENWORK_BRIDGE_TUNNEL=0`) or mid-restart |
| `POST /api/machine/name` | owm_/owd_ | Rename the machine — body `{name}` (trimmed, `"'\r\n` stripped, ≤60 chars) → updates `config.machineName` in RAM + config.json immediately (no bridge restart); new sign-ins see it via `/api/pair/tenant`, `/api/state` reports it live |
| `POST /api/openwork/wake` | owm_/owd_ (rate-limit 5/min/IP) | Launch OpenWork desktop on the computer (already running → `alreadyRunning`; launched → `launched`) |
| `POST /api/openwork/path` | owm_/owd_ (rate-limit 5/min/IP, shared with wake) | Point the bridge at the OpenWork.exe the phone can't find. Body `{path}` → saves `config.openworkExe` and returns `{ok, openwork}` (same shape `/api/state` sends). **Stores only, never spawns** — but the stored value IS what wake/boot spawn, so validation is: string, non-empty, quotes stripped (`normalizeExePathInput`), ≤400 chars, `existsSync`, `statSync().isFile()` **and `isOpenWorkExeName()`** (file named exactly `OpenWork.exe`). 400 `invalid_path` / `not_found` / `not_a_file` / `not_openwork_exe` / `invalid_body` / `fs_error`, each with a Vietnamese `message` the web shows verbatim |
| `GET /api/fs/ls?path=` | owm_/owd_ | Browse the computer's folders. No `path` → `{isWindows, home, roots[], quick[]}`; with `path` → `{path, parent, name, dirs[]}` (dirs only). Errors: 404 ENOENT/ENOTDIR, 403 EACCES |
| `POST /api/fs/mkdir` | owm_/owd_ | Create a folder `{dir, name}` → `{path, name}`. 400 EEXIST/EINVAL (name clash/forbidden chars), 403 EACCES |
| `/api/ow/<path>` | owm_ (header or `?_t=` for GET) | Proxy to openwork-server. Whitelist: `/workspaces*`, `/workspace/:id/(events|session-groups|files|opencode/*|engine/reload|artifacts|inbox)`, `/approvals*`, `/files/sessions/*`, `/experimental/(ui-control|extensions)`, `/status`, `/capabilities`, `/whoami`, `/health` |

## Frequently used openwork-server endpoints (via `/api/ow/`)

| Endpoint | Purpose | Shape notes |
|---|---|---|
| `GET /workspaces` | List workspaces | `{workspaces:[{id,name,path,workspaceType}...]}` |
| `POST /workspaces/local` | Create a ws `{path, name}` | auth "host" = owner bearer OK |
| `GET /workspace/:id/opencode/session` | Sessions | `{data:[{id,title,time:{updated}}]}`, sort by updated |
| `GET .../opencode/session/status` | Busy/idle map | `{ses_id:{type}}` (may be wrapped in .data) |
| `GET .../opencode/session/:sid/message` | Transcript | `{data:[{info:{id,role,time}, parts:[{type,text|tool|reasoning}]}]}` — **role lives inside `.info`** |
| `POST .../opencode/session/:sid/prompt_async` | Send a prompt | body `{parts:[{type:"text",text}], model:{providerID,modelID}, agent?}` → 204. **Model is an object, mandatory.** The body also accepts `noReply`, `tools`, `system`, `variant`, `reasoning_effort` — the app now sends `variant`/`reasoning_effort` (model picker) and `agent`; `noReply`/`tools`/`system` stay unused |
| `POST .../opencode/session/:sid/abort` | Cancel | |
| `POST .../opencode/session/:sid/revert` | Undo back to a message | body `{messageID}` → sets `session.revert.messageID`; **the transcript endpoint still returns every message — the client has to cut them** |
| `POST .../opencode/session/:sid/unrevert` | Clear that cursor | |
| `POST .../opencode/session/:sid/fork` | Branch a session | body `{messageID?}` — the engine copies messages **strictly before** `messageID`, so to branch *at* a message you must pass the NEXT one; empty = whole session |
| `POST .../opencode/session/:sid/command` | Run a slash command | body `{command, arguments?, model?}` |
| `DELETE .../opencode/session/:sid/message/:mid` | Delete a single message | |
| `GET .../opencode/session/:sid/todo` | The agent's task list | `[{content,status,priority}]` |
| `GET .../opencode/agent` | Agents to choose from | `[{name,description,mode,hidden,...}]` |
| `GET .../opencode/command` | Slash commands + skills | `[{name,description,source,template,hints}]` |
| `GET .../opencode/question` | Questions the agent is waiting on | `[{id,sessionID,questions:[{question,options,multiple,custom}]}]` |
| `POST .../opencode/question/:qid/reply` | Answer | body `{answers:[["label",...], ...]}` — one array per question, in order |
| `POST .../opencode/question/:qid/reject` | Skip (the agent proceeds on its own) | |
| `GET .../opencode/doc` | Full OpenAPI of the engine | **ground truth for what the engine supports — check here before assuming a feature needs backend work** |
| `DELETE .../opencode/session/:sid` | Delete a session | |
| `GET .../opencode/config/providers` | Available models | `{providers:[{id,name,models:{id:{name}}}]}` |
| `GET .../opencode/file?path=` | List a folder | `{data:[{name,path,type,size}]}` |
| `GET .../opencode/event` | Engine SSE | events are named (session.updated, message.updated, message.part.updated, permission.updated) |
| `GET/POST /workspace/:id/files/raw` | Read/write any file | POST body `{path, dataBase64}` → `{ok:true,path,bytes}` |
| `GET /workspace/:id/files/stat?path=` | Stat a file | `{ok,exists,path}` |
| `GET/POST /approvals`, `POST /approvals/:id` | Permission inbox | |

## OpenWork data the bridge depends on

| File | Meaning | Risk when OpenWork updates |
|---|---|---|
| `%APPDATA%\openwork\engine-instances.json` | Engine port + pid + ownerPid | Field rename → fix `discovery.js` |
| `%APPDATA%\openwork\tokens.json` | Token store (sha256) | The server loads once at startup → new tokens need a restart to be picked up |
| `%APPDATA%\openwork\server.json` | Workspace registry | The bridge only reads it indirectly via the API |
| runtime config (in runtime.sqlite) | managedPolicy + providers | Cloud sign-in expires → every mutation is blocked until the app is verified |

## Decisions / knowledge worth remembering

- **Node 18+ `req` 'close' does not mean the client aborted** — it also fires when a request finishes normally; upstream aborts must key off `res.on('close')` + `!res.writableEnded`.
- **POST bodies through the proxy must be buffered** — streaming (chunked) hangs openwork-server with no response.
- The opencode engine inside OpenWork spawns with random `OPENCODE_SERVER_USERNAME/PASSWORD` each run — the real credentials live only in openwork-server memory, **the authProbe registry value is stale** → don't try to call the engine directly.
- Full E2E on 2026-09-12: create session → prompt (model `opencode/nemotron-3-ultra-free`) → "OK" reply after ~35s → delete; wrote/read `bridge-test.txt` fine.
- **Quick Tunnel (v1.1):** learned from [9Remote](https://github.com/decolua/9remote) — they also use a quick tunnel, plus: automated cloudflared + fresh QR on URL change + (they have) an edge lookup Workers map machineId→URL. We did the first two; the third (Workers) came later anyway as the fixed-URL worker. Public URL tested through the CF edge: /api/state + web + workspaces all 200.
- **Multi-tenant "one building, many rooms" (v1.7):** one shared web app for many machines — each bridge gets a room (KV `machine:<id>`), accounts `tenant:<id>` issued by the worker owner via `worker/scripts/tenant.mjs`. The web stores the permanent key + room name, NEVER the password; the worker holds no keys — a wrong room has nothing to steal. Real chained E2E on 2026-09-13: worker → tunnel → bridge issued the key, `/api/state` through the whole chain OK. **Room issuance is gated by the OWNER's Cloudflare login, not by the command**: `tenant.mjs` only works where wrangler is authenticated as the worker's account — anywhere else (friend machines, repo clones) the same command fails with Cloudflare `Authentication error [10000]`. Later the same day `POST /api/tenant/create` opened a guarded self-serve door (rate-limit 5/min/IP, 50-room cap, reserved names) — which the desktop GUI now drives silently (no form).
- **Free KV is a hard limit of ~1000 writes/day** → heartbeat stretched 60s → 15 minutes (stale 20 min), ~96 writes/day/room → fits ~10 rooms. A dead bridge still errors immediately via `bridge_unreachable` (the fetch itself fails), so staleness only delays the "offline" notice, never the main experience.
- **No credential ever rides a URL (2026-10-04)** — the old `sseUrl()` put `?_t=<token>` on every href/src that a browser had to fetch itself (`<a>`, `<img>`, `<iframe>` cannot set an `Authorization` header). That leaked the key into browser history, into the `Referer` of every later request, and into the logs of the worker / cloudflared / bridge. Now every request authenticates with a header: `<img>`/`<iframe>` fetch by header and get a `blob:` object URL (`blobUrlFor` in `web/src/api.js`, LRU-bytes cache in `web/src/lib/blob-cache.js`), and file links in chat markdown point at the app's own Files page (`#/ws/:id/files?...&open=…`) instead of a raw URL. `sseUrl()` is deleted. The room still rides `?_m=` (worker `url.searchParams.get("_m")`) — a room id is a routing label, not a secret.
- `requestToken()` in `bridge/src/auth.js` still accepts `?_t=` on GET. Kept deliberately: an installed PWA may still be running a cached older bundle, and dropping it would strand those users mid-session. No current code path emits it.
- **Cache limits must not evict what the user is looking at** — `createBlobCache` evicts oldest-first but always keeps the entry just added, so opening one oversized file never blanks the image you were viewing. Passing `{entries: n}` must not blank the byte limit (an explicit `undefined` overrides a spread default).
- **The phone-side keyring (multi-machine, v2.8) was REMOVED with the one-PC simplification (13/09)** — it lived as a Settings card ("Máy của tôi") with per-machine rename/leave/revoke, built purely in localStorage (`owm_keys`), never as one account owning N machines on the worker. Isolation is inherited, not added: each `owd_` key is hashed only in the `devices.json` of the machine that minted it, bridges never see each other, machines have no channel to the phone. What remains today: the keyring functions in `web/src/api.js` as internal plumbing (pairing writes it, Settings' "Gỡ pairing" consumes it) + the tests in `web/test/api-keyring.test.js`.
- **Security audit 2026-09-13 (Mimosa deep scan, sealed)**: 16 findings, all triaged. 15 false positives with receipts: the SSRF flags on `bridge/src/proxy.js` + `worker/src/index.js` are contained (path whitelist against a fixed upstream base + `redirect: "manual"` + global token gate; the worker's relay target is pinned to the KV-registered `https://*.trycloudflare.com` URL, writable only via `/__register` with the room secret), and the `spawnSync` option-injection flags in `bin/openpocket.js` only ever pass the machine owner's own CLI args (array-form, no shell — the local user could run node directly anyway). Real: the GUI tenant-form quoting hardened; the `sharp`-family CVE exposure disappeared when that dependency was removed from the bridge entirely. Lesson: triage static scanner findings against the actual gates (whitelist, secret, threat actor) before "fixing" — 15 of 16 were noise. Receipt: scan `scan-2026-09-13T04-15-49.366Z-e206b249876f`, seal `sha256:08bb9be0f031174a95b18f96ba8bfd9d0853bd6d86bdd29485ab8681dcfef5d4`.
- **Security hardening round 2 (2026-09-13, user-approved subset)**: the default room password `12345678` is GONE — Enter at any password prompt (on the surfaces that existed then) auto-generates a strong `owes_`+48-hex secret; self-serve room creation requires 8–128 chars without `space " ' : &`. The worker stamps a strict CSP on all static assets (`withSecurityHeaders`): scripts same-origin only (no inline), styles inline-only, `img-src data: blob:` for file-preview object URLs — verified in a real browser that the app renders, the service worker activates, and injected inline/external scripts are blocked while the app's own resources trigger zero violations. **Rejected by the user, do not re-propose**: rate-limiting all `/api/*` and a confirmation dialog for invite links — the KV-read-quota flood risk and the weird-invite-link phishing vector are accepted as-is. Rooms created before this change with the old default password should be re-keyed (revoke + add).

## Run

```bash
# bridge
cd bridge && npm install && npm start     # QR + pairing code printed to the terminal
# web (builds web/dist served by the bridge)
cd web && npm install && npm run build
# unit tests (point OPENWORK_BRIDGE_DIR/OPENWORK_DIR at temp dirs first)
cd bridge && npm test
# live E2E (needs OpenWork running + the one-time restart already done)
node bridge/scripts/e2e-live.mjs <wsId> opencode nemotron-3-ultra-free
# remote (default): the bridge reports its tunnel URL to the worker automatically; set OPENWORK_PUBLIC_URL only when fronting the bridge yourself
# room admin on the real KV (requires logged-in wrangler)
cd worker && node scripts/tenant.mjs add alice "Alice's PC" [worker-url]   # or: list / revoke alice
```
