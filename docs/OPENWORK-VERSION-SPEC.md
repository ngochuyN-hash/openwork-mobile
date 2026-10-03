# Spec — "Hỏi người dùng bản OpenWork" (lên web)

> Written by the user in one line: *"tính năng hỏi người dùng bản openwork có mà cũng chưa clone lại trên web"*.
> Expanded here into something a subagent can implement without guessing.
> **English is the language of README/CODE_SUMMARY only; code comments and UI strings stay Vietnamese
> (project house style).**

## 1. The gap, in the current code

- `bridge/src/openwork-launch.js` already knows how to FIND `OpenWork.exe`
  (`candidateExePaths`, `findOpenWorkExe`) and how to launch it (`launchOpenWork`).
- `bridge/src/config.js:63` already reads `openworkExe` from `%APPDATA%\openwork-bridge\config.json`,
  and `bridge/src/index.js:376` already reports `openworkExeFound: Boolean(...)` in `/api/state`.
- `web/src/pages/settings.jsx:111` renders one row: "OpenWork .exe → tìm thấy / chưa tìm thấy (bật từ xa có thể lỗi)".

So the phone already gets a boolean. What it does **not** get:

1. **The version of OpenWork desktop installed on the machine.** `/api/state` reports
   `server.version` (openwork-server) and `server.opencodeVersion`, and `bridgeVersion` —
   the desktop app itself is invisible. The installed `OpenWork.exe` reports
   `ProductVersion 0.18.54` on the owner's machine (verified 2026-10-03 via PowerShell),
   and `resources/app.asar → package.json` carries the same `"version": "0.18.54"`.
2. **Any way to fix "chưa tìm thấy".** The row is a dead end: `openworkExe` is only settable by
   hand-editing `config.json` or setting `OPENWORK_EXE` in the bridge's environment.
   `/api/openwork/wake` answers `openwork_exe_not_found` with a `candidates` array
   (`bridge/src/index.js:456`) that the web app currently **discards**.

## 2. What to build

### 2.1 Bridge — read the installed version (new module `bridge/src/openwork-version.js`)

Pure Node, **no new dependency** (the project has exactly one, `qrcode-terminal`).

Two sources, in order:

1. **`resources/app.asar` → `package.json`.** An asar is a 16-byte header followed by a
   JSON directory: `headerSize = uint32LE at offset 12`, the JSON lives at offset 16, file
   payloads start at `16 + headerSize + Number(entry.offset)`. Parse
   `header.files["package.json"]` and read `"version"`. Verified working on the owner's
   machine (`0.18.54`). Header on that build is ~3.5 MB — read it in chunks, never slurp the
   whole 225 MB exe.
2. **Fallback: nothing.** If the asar is missing or unparseable, return `""` — do **not** shell
   out to PowerShell to read the PE version resource. A spawn per `/api/state` poll is a cost
   the phone pays on every refresh; the asar covers real installs.

Export pure helpers so they are unit-testable without a real install:

- `readAsarPackageJson(asarPath)` → `object | null` — null on missing/short/corrupt header.
- `openworkVersionFrom(exePath)` → `string` — `""` when unknown; takes the exe path, returns
  `join(dirname(exePath), "resources", "app.asar")` lookup.
- `describeOpenWorkInstall({ configOpenworkExe })` → `{ found, exe, version, source }` where
  `source` is `"config" | "env" | "wellknown"` — which of `candidateExePaths` actually matched.

### 2.2 Bridge — API

- Extend `GET /api/state` with an `openwork` object:
  `{ found, exe, version, source, candidates }` (`candidates` only when `found` is false —
  that is what the phone needs to offer the user a choice).
  **Keep the existing `openworkExeFound` boolean** — it is in the response contract and other
  code reads it.
- New `POST /api/openwork/path` body `{ path }`:
  - Reject non-string/empty, > 400 chars, or anything that is not an existing **file**
    (`bridge/src/fslist.js` has the helpers/idioms) → 400 with a Vietnamese `message`.
  - **Never spawn or execute the path.** Validation is `existsSync` + `statSync().isFile()` only.
    This route accepts a path typed by a phone; treating it as a command to run would be a
    remote-code-execution hole.
  - On success: `config.openworkExe = path; saveConfig(config);` and return
    `{ ok: true, openwork: describeOpenWorkInstall(...) }` so the UI updates in one round trip.
  - Rate-limit it like `/api/openwork/wake` does (`bridge/src/index.js:94` `wakeRateLimited`,
    5/min/IP → `deny(res)`). Reuse the existing pattern, do not add a new limiter family.
  - It sits behind the existing auth gate at `bridge/src/index.js:307` — that is automatic if
    it is added after that line; verify it is.
- `worker/src/index.js` needs **no change**: `relay()` forwards any `/api/*` path to the
  bridge. Confirm by reading it rather than assuming.

### 2.3 Web — show it, and let the user fix it

- `web/src/api.js`: add `apiOpenWorkPath(path)` next to `apiWakeOpenWork()` (`:221`), same
  shape (calls `ow()`, throws the bridge's `message`).
- `web/src/pages/settings.jsx`:
  - Replace the dead "OpenWork .exe" row with a card section "OpenWork trên máy tính":
    version (`v0.18.54` or "không đọc được"), the resolved path, and where it came from.
  - **When `found === false`, show the fix, not just the verdict**: the `candidates` list from
    `/api/state` as tappable suggestions, plus a text input to type any other path, plus a
    "Chỉ đường dẫn" button that calls `apiOpenWorkPath`. On success re-render from the
    returned `openwork`; on failure show the bridge's own Vietnamese `message` verbatim —
    never swallow it.
  - `wake()` currently discards `e.candidates`; wire those candidates into the same chooser so
    the two paths agree.
- Reuse existing tokens/classes (`styles.css` is being edited by another session right now —
  see §5). No new CSS file unless unavoidable; prefer `label.field`, `.btn`, `.card`,
  `.page-actions`, `.hint`.

### 2.4 Tests

- `bridge/test/openwork-version.test.js` — build a **fake asar in a temp dir** (16-byte header
  + JSON + payload, written by the test) and assert: version parsed; missing file → `""`;
  truncated header → `""`; `describeOpenWorkInstall` reports the right `source`.
  This is the point of the module: no test may touch the real `%LOCALAPPDATA%`.
- `web/test/api-openwork.test.js` (a NEW sibling file — this exact name) — assert
  `apiOpenWorkPath` sends the body/header the bridge expects and surfaces the bridge's error
  `message`. Copy the shim preamble from `web/test/api-contract.test.js` verbatim
  (localStorage/location/history/window stubs + the two `mkdtempSync` env lines).
- House rule (see `web/test/api-contract.test.js:11`): set
  `OPENWORK_BRIDGE_DIR` and `OPENWORK_DIR` to `mkdtempSync()` dirs before importing.

## 3. Commands that decide the result

Both verified working from the workspace root on 2026-10-03. `node --test` needs explicit
**file paths** (directory form fails with MODULE_NOT_FOUND), so glob first:

- Tests: `node --test <bridge/test/*.test.js> <web/test/*.test.js>` — expect exit 0.
- Build: `node web/node_modules/vite/bin/vite.js build web` — expect exit 0.

**File name is fixed** (the gate script lists paths explicitly, so a test written under a
different name would never run): bridge → `bridge/test/openwork-version.test.js`;
web → `web/test/api-openwork.test.js`.

## 4. Definition of done

1. `/api/state` returns the OpenWork desktop version on a machine that has it.
2. On a machine without it, the phone shows a real way to point the bridge at the exe.
3. Bridge + web tests pass, web builds clean.
4. `README.md` and `CODE_SUMMARY.md` updated **in English, in the same change** (project rule).

## 5. Hard constraints — do not violate

- **Another session is editing these files right now** (verified via `git status` at
  2026-10-03 16:20): `web/src/pages/chat.jsx`, `web/src/pages/files.jsx`,
  `web/src/lib/chat-stream.js`, `web/src/styles.css`, `web/test/chat-stream.test.js`,
  plus uncommitted edits in `README.md` and `CODE_SUMMARY.md`. Do not edit them; if the feature
  genuinely needs `styles.css`, note it in the report instead of fighting over the file.
- `web/dist/` is gitignored — a successful build does not dirty the tree.
- **No commit, no push, no `wrangler deploy`.** The owner reviews locally first.
- Hardening stays invisible: no new nag screens, no keystroke logging, no new throttles beyond
  the one rate limit the new route needs.

## 6. Ghi chú sau khi triển khai (2026-10-03)

### 6.1 KHÔNG cần CSS mới — `web/src/styles.css` không bị đụng tới

Card "OpenWork trên máy tính" trong `settings.jsx` dựng lại hoàn toàn bằng class có sẵn +
`style` inline:

| Dùng lại | Nguồn |
|---|---|
| `.card`, `.file-row`, `.name`, `.mono`, `.sheet-body` | styles.css |
| `button.btn.small` (nút "Dùng") | `web/src/styles.css:557` |
| `label.field` (nhãn + ô gõ đường dẫn) | `web/src/styles.css:591` |
| `.banner` qua component `Banner` | `web/src/components/ui.jsx` |

`git status web/src/styles.css` = sạch (file không nằm trong danh sách `M` của lượt này), nên
ràng buộc "file session khác đang sửa" ở §5 được giữ nguyên. **Không có yêu cầu CSS nào để
lại cho session sau.**

### 6.2 Hai chỗ làm CHẶT HƠN spec — nên giữ, đừng "sửa lại cho đúng spec"

1. **`isOpenWorkExeName()` trong `openwork-launch.js`** — spec §2.2 chỉ yêu cầu
   `existsSync + statSync().isFile()`. Đã thêm điều kiện tên file phải đúng là `OpenWork.exe`
   (so case-insensitive, `basename`). **Lý do:** giá trị mà route này lưu vào
   `config.openworkExe` chính là thứ `spawn()` thật ở `/api/openwork/wake` và auto-launch lúc
   boot. Chỉ kiểm "tồn tại + là file" thì một chiếc điện thoại đã ghép cặn có thể trỏ bridge
   sang `C:\Windows\System32\calc.exe` → bridge mở calc. Đây là lỗ hổng RCE từ xa, không phải
   chi tiết làm đẹp.
2. **Cache version theo `mtimeMs:size`** trong `openwork-version.js` — không có trong spec, nhưng
   `/api/state` bị điện thoại poll mỗi 15s và header asar thật ~3.5 MB: đo được ~13 ms/lần
   (đọc + `JSON.parse` đồng bộ, chặn event loop của bridge), giảm còn ~0.02 ms khi cache hit.
   Nâng cấp app là tự vô hiệu hoá.

Ngoài ra: `apiOpenWorkPath()` **không được** bọc trong `ow()` — `ow()` prefix `/api/ow` (proxy
openwork-server), còn `/api/openwork/path` là route của bridge. Nó gọi `fetch()` thẳng, y hệt
`apiWakeOpenWork()`.

### 6.3 Đã chạy trong lượt làm tài liệu này

- `node --test bridge/test/*.test.js` → **47 pass / 0 fail** (11 file, exit 0)
- `node --test web/test/*.test.js` → **44 pass / 0 fail** (4 file, exit 0)

**CHƯA chạy:** `node web/node_modules/vite/bin/vite.js build web` — build không nằm trong phạm vi
lượt tài liệu này, nên trạng thái build là **chưa xác minh**, đừng coi là đã pass.

### 6.4 Tài liệu đã cập nhật cùng lượt (tiếng Anh, theo rule dự án)

Lượt tài liệu này **chỉ bổ sung**, không viết lại — `README.md` và `CODE_SUMMARY.md` đã có sẵn
phần mô tả tính năng này trong working tree (session code đã ghi trước, đã đối chiếu lại với
source và thấy khớp). Phần thêm mới:

- `README.md`: 1 bullet mới trong **Features** ("Which OpenWork is on the computer?").
- `CODE_SUMMARY.md`: bổ sung vào các dòng bảng file **`bridge/src/index.js`** (route
  `/api/openwork/path` + trường `openwork` trong `/api/state`), **`web/src/api.js`**
  (`apiOpenWorkPath` không được bọc trong `ow()`, `error.candidates` của wake, số test 25 → 44)
  và **`web/src/pages/settings.jsx`** (card "OpenWork trên máy tính" thay dòng chết,
  không cần CSS mới).

Các dòng đã có sẵn từ trước và giữ nguyên: 2 dòng bảng triệu chứng (tiếng Việt), dòng file
`openwork-launch.js` / `openwork-version.js` + 2 dòng test của bridge, và 2 dòng bảng API
(`/api/state`, `/api/openwork/path`).