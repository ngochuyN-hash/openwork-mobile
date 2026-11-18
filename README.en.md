# OpenWork Mobile

**Use the [OpenWork](https://github.com/different-ai/openwork) desktop AI-coder from your phone — from
anywhere, with no app to install.**

OpenWork Mobile is a web app (PWA) plus a small local bridge that lets a phone reach the
`openwork-server` instance already running inside OpenWork desktop: browse sessions and workspaces,
read and send chat, review files, edit and upload them. It works on iOS and Android through a plain
browser, and adding it to the home screen behaves like a native app.

> **This is a fork.** Upstream is [`ngochuyN-hash/openwork-mobile`](https://github.com/ngochuyN-hash/openwork-mobile)
> (MIT). The original targets the **v1** `openwork-server` API. This fork adds a **v2 adapter**, so the
> app keeps working after OpenWork moved to the OpenCode 2.x engine. See
> [What this fork changes](#what-this-fork-changes).
>
> The detailed engineering log is still in Vietnamese: [`README.md`](./README.md) (65 KB),
> [`CODE_SUMMARY.md`](./CODE_SUMMARY.md) (225 KB), [`docs/`](./docs). This file is a shorter,
> English-language entry point.

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Setup](#setup-computer-once)
- [Pairing your phone](#pairing-your-phone)
- [What this fork changes](#what-this-fork-changes)
- [Known limitations](#known-limitations)
- [Security model](#security-model)
- [Repository layout](#repository-layout)
- [Tests](#tests)
- [License and attribution](#license-and-attribution)

## How it works

```
  Phone (any browser / PWA — nothing to install)
     │  HTTPS
     ▼
  Cloudflare Quick Tunnel  ← spawned by the bridge, free, no account
     │
     ▼
  Bridge  (1 Node process, zero npm dependencies, 127.0.0.1:8788)
     │  · serves web/dist (the PWA)
     │  · discovers openwork-server and holds its owner token
     │  · forwards a fixed whitelist of paths, nothing else
     ▼
  openwork-server  (inside OpenWork desktop)
     │
     ▼
  OpenCode engine  (v1: /workspace/<ws>/opencode · v2: /workspace/<ws>/opencode2)
```

Three deliberate design rules:

1. **Never rewrite what OpenWork already provides.** The bridge is a thin layer: find the server, hold
   the token, expose one whitelisted surface, serve the static app.
2. **The token never travels in a URL.** It goes in the `Authorization` header; log output is
   redacted (`bridge/src/log-safe.js`, with tests).
3. **Nothing to install on the phone.** No APK, no TestFlight, no account.

The bridge also reports its current tunnel address to an optional Cloudflare Worker
(`worker/`), so the phone can remember **one** permanent URL even though a Quick Tunnel address
changes on every restart.

## Requirements

- **Windows** computer running OpenWork desktop
- **Node.js ≥ 20** (`node.exe` runs the bridge)
- A phone with a modern browser
- No Cloudflare account needed (Quick Tunnel). An optional Worker is free too.

## Setup (computer, once)

```bash
# 1. Bridge (no dependencies to install)
cd bridge
npm start

# 2. Web app (built once; rebuild after editing web/src)
cd ../web
npm install
npm run build
```

Start the bridge first or last — order does not matter, it discovers the server when it appears.

On first run the bridge mints a token into OpenWork and prints a **QR code holding a one-time
pairing code, valid for 30 minutes**.

> **Restart OpenWork desktop exactly once** after the first bridge run. OpenWork only reads
> `tokens.json` at startup, so the freshly minted token is not live until then. The bridge detects
> this and says so — it is a one-time step.

Useful commands (`bridge/bin/openpocket.js`, exposed as `openpocket`):

| Command | Purpose |
|---|---|
| `openpocket start` | run the bridge in the background (mints pairing code, tunnel, heartbeat) |
| `openpocket stop` / `status` | stop it / check whether it is alive |
| `openpocket code` | print the current pairing code (30 min) with a QR |
| `openpocket logs` | tail the bridge log |
| `openpocket autostart --enable --with-openwork` | start bridge + OpenWork at Windows login |

To run without a public tunnel: `OPENWORK_BRIDGE_TUNNEL=0`.

## Pairing your phone

1. The bridge starts, opens a Cloudflare Quick Tunnel itself (downloads `cloudflared` on first run,
   ~50 MB) and prints a public URL like `https://xxx.trycloudflare.com` with a QR.
2. Open that link on the phone — over 4G, from anywhere. The app pairs itself and stores a
   **device key**.
3. *Add to Home Screen*. From then on, tapping the icon puts you straight back in.

A Quick Tunnel URL **changes whenever the bridge or cloudflared restarts**. The bridge prints a fresh
QR; rescanning takes seconds. If you want a URL that never changes, deploy the Worker in `worker/`
(free) — the bridge re-registers its current address there automatically.

Cloudflare rate-limits Quick Tunnel creation **per IP** (HTTP 429 / error 1015). Each bridge restart
mints a new tunnel request, so restarting repeatedly extends the block. The bridge backs off on its
own (doubling from 120 s, capped at 10 min) and persists the countdown across restarts
(`tunnel-state.json`), so a restart resumes the wait instead of resetting it.

## What this fork changes

Upstream speaks the **v1** `openwork-server` API. OpenWork 2.x replaced that engine-facing surface
with a **v2** one, which broke the port. This fork keeps the pages untouched by translating at the
boundary instead of rewriting the UI:

| Area | Change |
|---|---|
| Bridge | Proxy whitelist accepts the `opencode2` engine segment as well as `opencode` (`opencode2?(/\|$)`), so one bridge serves v1 and v2 installs |
| Transport | `web/src/api.js` rewritten over the v2 routes; hex IDs, cursor pagination, provider/model listing |
| Compatibility | New `web/src/lib/v2-api.js` translates v2 payloads into the v1 shapes the pages already consume (`toV1Session`, `toV1Message`, `translateV2Events`, …) |
| Streaming | v2 stream frames carry no `event:` line (the type is a field inside the JSON) — handled in the reader, not guessed |
| Turn state | `session.idle` / `session.status` are synthesised from `session.execution.succeeded \| failed \| interrupted`, with the existing `/api/session/active` poll as a fallback |
| Questions | v2 replaced session questions with **forms**: answered via `POST /api/session/{sid}/form/{formID}/reply` with `{answer:{<field>:<value>}}`, rejected with `DELETE` |
| Dropped | Share link, todo list and delete-message do not exist in v2; the share button is gone from the chat header rather than left as a dead control |

Also in this fork: a **chat layout fix** for narrow viewports (a global `.file-row` rule from the
Files page was also matching the chat file row, letting one long filename widen the whole document to
537 px on a 330 px screen — the composer then looked detached and history bled through it), and
neutralised Windows usernames in test fixtures.

Verified against **openwork-server 2.2.6 / OpenCode 2.x engine** (77 models listed through
`/api/model`), with web tests at 508/508 and bridge tests at 156/156.

## Known limitations

- **A Quick Tunnel cannot stream.** Cloudflare buffers a streamed response body, so Server-Sent
  Events never reaches a remote client through a Quick Tunnel. The app therefore also **polls**:
  when the active-session status flips from running to idle it refetches the transcript, and an 8 s
  dead-channel watchdog covers the rest. Chat stays correct; token-by-token live typing does not
  appear until the turn ends. A named tunnel with a domain does stream.
- **Never call `POST /api/session/{id}/interrupt`** while the bridge is mid-turn: on the tested build
  it blocks the server's event loop and kills in-flight tool calls. The app's Stop button uses it, so
  treat Stop as a last resort and prefer letting the turn finish.
- A restarted OpenWork can leave a session showing a stale "agent is running…" label until the app
  is reloaded; the poll clears the transcript, not the label.
- Windows-only bridge (it reads OpenWork's local data directory and starts `cloudflared`/`node` as
  child processes). The web app and the Worker are platform-neutral.

## Security model

Read this before exposing it to the internet. The whole point of the project is to make a desktop
agent reachable from a phone, so the bridge is the security boundary:

**What is protected**

- Every `/api/*` request needs a bearer token (`bridge/src/auth.js`, constant-time comparison).
  Pairing codes are one-time and expire in ~30 minutes.
- The proxy forwards a **fixed whitelist** of path prefixes only. Request paths are matched against
  it, redirects are not followed, and the upstream base is pinned — that is what contains the SSRF
  class of findings.
- The Worker's `/__register` endpoint only accepts `https://*.trycloudflare.com` addresses, behind a
  per-room secret.
- Tokens are redacted from logs; the QR/pairing output is TTY-gated so it never lands in a log file.
- `desktop/invite.key`, `desktop/src/InviteKey.cs` and `desktop/src/IdentityKeys.cs` are gitignored —
  a build from a fresh clone cannot create rooms on someone else's Worker.

**What is not protected, and you should assume**

- Anyone holding a valid device key has **full access to the whitelisted surface** — chat, file read,
  file write, upload. There is no per-user permission model and no audit log. Revoke a lost device by
  removing its key, not by hoping.
- The tunnel URL is public by nature. Pairing is what gates access, not obscurity.
- Quick Tunnel endpoints are scanned by the internet. Expect noise on 401s.
- File editing means the agent and the phone can both write to your workspace. Treat a paired phone
  as equivalent to sitting at the keyboard.

If you want a second layer, put Cloudflare Access (email OTP) in front of a **named** tunnel — the
README table on this topic is in the Vietnamese `README.md`.

## Repository layout

| Path | What it is |
|---|---|
| `bridge/` | Node service: discovery, token, whitelist proxy, tunnel, static hosting, pairing |
| `web/` | Preact PWA (Sessions · Workspaces · Chat · Files · Settings) built with Vite |
| `web/src/lib/v2-api.js` | v2 → v1 compatibility layer added by this fork |
| `worker/` | Optional Cloudflare Worker: fixed URL + multi-room relay |
| `desktop/` | Optional C# GUI launcher and installer scripts (Windows) |
| `shared/` | Contract constants shared by bridge, web and Worker, with pinning tests |
| `docs/` | Version spec, security review, review notes |
| `README.md`, `CODE_SUMMARY.md` | The original, much longer Vietnamese documentation |

## Tests

Node's built-in runner, no framework:

```bash
cd web && npm test        # 508 tests
cd bridge && npm test     # 156 tests
cd worker && npm test     # relay + registration tests
```

The suite is deliberately heavy on route tests, contract-pinning tests and redaction tests — the
parts where a silent regression would be a security bug rather than a broken screen.

## License and attribution

MIT. Original work © 2026 [ngochuyN-hash](https://github.com/ngochuyN-hash), see [`LICENSE`](./LICENSE).
This fork keeps the original licence and copyright notice; the v2 adapter and layout fix are
additional contributions under the same terms.

OpenWork itself is a separate project by [different-ai](https://github.com/different-ai/openwork);
this repository is an independent, unofficial mobile front end and is not affiliated with it.
