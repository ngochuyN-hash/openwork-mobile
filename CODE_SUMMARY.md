# CODE_SUMMARY — OpenWork Mobile

> Tài liệu tra nhanh "gặp lỗi thì sửa ở đâu". Cập nhật sau mỗi milestone.
> Cập nhật lần cuối: 2026-09-13 (v1.7: multi-tenant "tòa nhà nhiều phòng" + **xem & điều khiển màn hình PC từ điện thoại kiểu 9remote** — stream JPEG đẩy frame, daemon C# SendInput, gõ tiếng Việt đi clipboard)
>
> 📌 **Quy tắc (yêu cầu của chủ dự án):** mỗi khi thay đổi code/cấu trúc/hành vi,
> PHẢI cập nhật đồng thời file này VÀ `README.md` trong cùng commit.

## Kiến trúc tổng thể (1 dòng)

Điện thoại mở **đúng 1 URL cố định** (`https://YOUR-WORKER.workers.dev`) → Worker chọn "phòng" từ header `x-owm-tenant` (không có = `machine:main` của chủ worker) rồi trung chuyển sang địa chỉ tunnel HIỆN TẠI của phòng đó (bridge heartbeat mỗi 15 phút, đổi tunnel là báo ngay) → **openwork-bridge** (127.0.0.1:8788) → **openwork-server** (API có sẵn trong OpenWork, port động) → opencode engine.

```
[Phone: PWA — 1 URL cố định duy nhất, kèm phòng (header x-owm-tenant / ?_m=)]
        │  HTTPS qua CF edge
        ▼
[Worker openpocket]  ←relay /api/* sang tunnel của PHÒNG (auth nguyên vẹn, key do bridge kiểm tra)
        │  + serve web app static + quản lý phòng tenant:<id> trên KV
        ▼ (bridge heartbeat URL hiện tại mỗi 15 phút, stale >20 phút = offline)
[bridge :8788]  ←proxy whitelist, inject Bearer owt_ owner→  [openwork-server]*  →  [opencode engine]
                                                                    (*port động)
```

## Vì sao kiến trúc này

- OpenWork desktop (Electron) chạy sẵn **openwork-server** với API đầy đủ: workspaces, session-groups, approvals, files đọc/ghi, SSE events, và **proxy mount `/workspace/:id/opencode/*`** (gửi message `prompt_async`, abort, permission reply...). Bridge KHÔNG viết lại API — chỉ chuyển tiếp có chọn lọc.
- openwork-server auth bằng `Authorization: Bearer owt_...` (scope `owner` = full). Token lưu **sha256** trong `%APPDATA%\openwork\tokens.json`, server chỉ load 1 lần lúc khởi động → bridge tự mint token vào file này, restart OpenWork **đúng 1 lần** là dùng vĩnh viễn.
- Port openwork-server động (62222 hôm nay) → bridge tự tìm: đọc `engine-instances.json` lấy `ownerPid` → `netstat -ano` lấy các port của pid đó → probe `GET /health` (payload có `opencodeVersion` là đúng server).
- Tìm thấy tất cả các hiểu lầm về API bằng cách soi `app.asar` (extract bằng `npx @electron/asar extract`) — `server/dist/*.js` là code openwork-server, `app-dist/assets/app-*.js` là SPA chính chủ (ground truth cho request/response shape).

## Bản đồ file

### bridge/ (Node.js ≥20; deps: qrcode-terminal + `sharp` + `node-screenshots` cho tính năng màn hình)

| File | Trách nhiệm |
|---|---|
| `src/index.js` | Entry: bootstrap token → discovery loop (5s + fs.watch) → HTTP server (API + static). In QR pairing (**`currentBase()` ưu tiên `lookupUrl` — địa chỉ cố định — thay vì tunnel; link QR kèm `&m=<phòng>`**). Route **`POST /api/pair/tenant`** (đăng nhập multi-tenant: so user/pass với config, đúng thì `mintDevice` + trả `{token, device, tenant, machineName}`; chưa join → 404 `not_joined`; rate-limit chung với /api/pair). `/api/state` có thêm `edge: {tenant, machineName}`. Lưới an toàn uncaughtException. |
| `src/config.js` | Config runtime (mobileToken `owm_`, ownerToken `owt_`, port, publicUrl, **lookupUrl + lookupSecret + lookupTenant + machineName**). Nằm NGOÀI repo: `%APPDATA%\openwork-bridge\config.json`. `lookupTenant` rỗng = luồng máy chính (machine:main). |
| `src/bootstrap.js` | Mint/append token owner vào `%APPDATA%\openwork\tokens.json` (atomic + .bak). hash = sha256 hex thuần, id cố định `openwork-mobile-bridge`. |
| `src/discovery.js` | Đọc `engine-instances.json` (ownerPid) → parse netstat → probe `/health` → check `/whoami` (token active). |
| `src/proxy.js` | Reverse proxy `/api/ow/*` → openwork-server. Whitelist sau khi **normalize dot-segments**, method allowlist, inject Bearer owner, **body buffer (cap 64MB)**, stream response + SSE keepalive 20s. Forward thêm `content-length/content-range/accept-ranges` để tải file hiện tiến trình. |
| `src/auth.js` | Phone → bridge: `owm_` token (header) + `?_t=` (chỉ GET, cho EventSource/img). timingSafeEqual. `requestToken()` trích từ cả 2 nguồn, `isTokenAuthorized()` công nhận như nhau. |
| `src/static.js` | Serve `web/dist` (SPA fallback index.html). |
| `src/pairing.js` | Pairing kiểu 9Remote: mã one-time 8 ký tự (30 phút, 1 lần, in trong QR), khóa thiết bị vĩnh viễn owd_ (lưu hash trong devices.json), thu hồi. **`mintDevice(label)`** cấp khóa không cần mã — dùng chung cho pair-mã và đăng nhập phòng `/api/pair/tenant`. |
| `src/tunnel.js` | Auto Cloudflare Quick Tunnel (học từ 9Remote): tự tải cloudflared về data dir, spawn `tunnel --url :8788`, dò URL trycloudflare.com từ log, tự chạy lại khi chết, gọi `onUrl` (index.js in QR mới). Tắt bằng `OPENWORK_BRIDGE_TUNNEL=0`. |
| `src/lookup.js` | Heartbeat lên Worker (địa chỉ cố định): đăng ký URL tunnel hiện tại ngay khi đổi + giữ ấm mỗi **15 phút** (tiết kiệm KV free ~96 ghi/ngày/phòng; worker coi >20 phút là offline). Có `tenant` thì gửi kèm trong body `{url, tenant}` (chữ thường). |
| `src/openwork-launch.js` | Tìm file OpenWork.exe (env `OPENWORK_EXE` → config `openworkExe` → `%LOCALAPPDATA%\Programs\@openworkdesktop\`) + mở app detached ẩn. Dùng cho endpoint wake + tự mở lúc khởi động. |
| `src/autostart.js` | Dựng câu lệnh schtasks cho `openpocket autostart` (task `OpenPocketBridge`, ONLOGON, quoting đường dẫn có dấu cách). |
| `src/fslist.js` | Duyệt thư mục cho tính năng "Duyệt…" khi tạo workspace: `listRoots()` (ổ đĩa Windows dò A–Z + quick links (tên folder thật, vd user/Desktop/Documents/Downloads)) và `listDirs(path)` (CHỈ thư mục — không lộ file, bỏ ẩn `.`/rác hệ thống, symlink soi đích, sắp A→Z vi-locale). `makeDir(dir, name)` tạo thư mục con (chặn ký tự cấm  / : * ? " < > |, báo rõ khi trùng tên). |
| `src/screen.js` | **Xem + điều khiển màn hình (v1.7, học cơ chế 9remote v2.5.8 soi từ bản npm trên máy).** `ScreenService`: có người xem mới chạy vòng chụp (~3-4 hình/s, `node-screenshots` chụp monitor chính → `sharp` resize+JPEG); stream binary `[4B len][1B type][payload]` (0=đứng yên/1=JPEG/2=meta/3=lỗi), **KHÔNG ghi đĩa** — RAM giữ 1 frame/params; không ai xem 90s → dừng chụp + kill daemon (lifecycle kiểu "Remote streaming stopped"). Input: daemon C# qua stdin/stdout JSON-line (`normalizeInput()` đổi tọa độ 0..1 → pixel, validate key/mods/text). `compileInputExe()` compile `desktop-input.cs` 1 lần bằng csc vào data dir (ver = sha1 source, đổi source là tự compile lại). Export thuần cho test: `encodeFrame`, `normalizeInput`, `createRateLimiter`. |
| `src/desktop-input.cs` | Daemon điều khiển chuột/bàn phím (C# 5 thuần — csc .NET Framework không hiểu cú pháp mới, bài học copy từ desktop-bridge.cs của 9remote). SendInput: move/click/double/down/up (MOUSEEVENTF_ABSOLUTE 0..65535), wheel, key/combo (VK map), **TEXT = set clipboard + Ctrl+V** (`System.Windows.Forms.Clipboard`, [STAThread], retry 5×200ms khi clipboard bận). `SetProcessDPIAware` + PING trả `<rộng>x<cao>` — bridge đồng bộ dims theo góc nhìn daemon. **ĐỪNG quay lại gõ phím Unicode (KEYEVENTF_UNICODE): IME tiếng Việt (Unikey/Telex) biến "chào" thành "OOOOO" — đã thử thật.** |
| `bin/openpocket.js` | Lệnh toàn cục: start/stop/status/logs/code + **`edge join <worker>` (hỏi user/pass — pass ẩn ký tự — lưu config, tự restart bridge nếu đang chạy) + `edge status`** + `autostart --enable [--with-openwork]/--status/--disable` (Task Scheduler, chạy ẩn, log ra bridge.log). `code` đọc link pair từ log (nhận cả link worker có `&m=`), master QR ưu tiên worker + kèm `&m=`. |
| `src/paths.js` | Vị trí `%APPDATA%\openwork` (env `OPENWORK_DIR` override cho test). |
| `test/bridge.test.js` | Unit: netstat parse, whitelist + traversal, auth, hash. `npm test` |
| `test/pairing.test.js` | Unit pairing kiểu 9Remote: mã 1 lần, mã sai/hết hạn, khóa thiết bị + thu hồi, persist đĩa, **mintDevice (khóa không cần mã, không tiêu mã one-time)**. |
| `test/lookup.test.js` | Unit heartbeat: đăng ký NGAY khi khởi động (body kèm `tenant` chữ thường), không tenant giữ body cũ `{url}`, cùng URL trong nhịp giữ ấm không ghi lặp, đổi URL đăng ký lại ngay (server bắt gói thật, tick/heartbeat inject ngắn cho test). |
| `test/screen.test.js` | Unit màn hình: encodeFrame khớp parse, normalizeInput (tọa độ 0..1→pixel, wheel clamp, key/combo/text, chặn đầu vào xấu), rate limiter trượt. |
| `scripts/e2e-live.mjs` | E2E: tạo session → prompt_async → poll reply → delete. `node scripts/e2e-live.mjs <wsId> <providerId> <modelId>` |
| `scripts/dbg-screen.mjs` | Live test màn hình: move chuột + đọc vị trí thật, chụp 1 frame `tmp-screen.jpg`, mode `notepad` (tự mở Notepad, **kiểm tra foreground trước khi gõ** — an toàn, ALT+SetForegroundWindow để nhận focus, xong trả focus + đóng notepad theo pid). |
| `scripts/dbg-prompt.mjs` | Debug prompt: dump status + parts mỗi 5s. |

### worker/ (Cloudflare Worker `openpocket` — "địa chỉ cố định" + multi-tenant)

| File | Trách nhiệm |
|---|---|
| `src/index.js` | KV có 2 loại key: `tenant:<id>` = `{secret, name, createdAt}` (tài khoản do script cấp) và `machine:<id>` = `{url, updatedAt}` (tunnel hiện tại của phòng; `machine:main` = máy chủ worker, secret env `BRIDGE_SECRET`, không cần tenant). `POST /__register`: có `tenant` trong body → so secret với `tenant:<id>` (timing-safe); không → luồng cũ. `/api/*`: chọn slot theo header `x-owm-tenant` / `?_m=` (EventSource) / rỗng = main; riêng `POST /api/pair/tenant` đọc phòng từ `body.user` rồi **worker tự so secret TRƯỚC khi relay — phòng lạ và sai mật khẩu trả cùng một câu 401, không dò ra được phòng nào tồn tại** (bridge vẫn so lại pass lần 2). Offline khi stale >**20 phút**. **Relay xin `accept-encoding: identity` + tự bóc `content-encoding: gzip/deflate` bằng `DecompressionStream`** — edge CF từng tự nén response tunnel làm client không xin gzip nhận body rác. Còn lại serve web static từ assets. |
| `wrangler.jsonc` | name `openpocket` + assets `../web/dist` (SPA, run_worker_first `/api/*`) + KV binding. Lệnh: `npx wrangler kv namespace create` → `wrangler secret put BRIDGE_SECRET` → `wrangler deploy`. |
| `scripts/tenant.mjs` | Quản lý phòng trên KV (chạy tại máy chủ worker, cần wrangler đã đăng nhập): `add <user> "Tên" [url]` sinh secret `owes_...` + ghi `tenant:<user>` + in "thẻ mời" 2 bước cho bạn; `list`; `revoke <user>` (xóa cả `tenant:` lẫn `machine:` — máy đó hết chỗ đăng ký). Đọc namespace id từ wrangler.jsonc. **Gọi wrangler TRỰC TIẾP `node …/web/node_modules/wrangler/bin/wrangler.js`, KHÔNG qua shell** — trước dùng `spawnSync("npx", …, shell:true)` thì cmd Windows nuốt mất dấu nháy JSON, KV lưu `{secret:…}` không còn là JSON (đăng nhập luôn 401 dù pass đúng); get trả 404 coi là "phòng chưa tồn tại", không phải lỗi. |

### web/ (Preact + Vite → dist ~78KB gzip 26KB, design v4 "desktop-first")

| File | Trách nhiệm |
|---|---|
| `src/styles.css` | Design tokens v4 (skill `.zcode/skills/pwa-workspace-ui/references/tokens.md`): light/dark tự theo hệ thống (nền `#f8fafc`/`#111113`), nút chính ĐEN/TRẮNG biến `--primary`, chấm màu workspace `WS_COLORS`, logo lục giác chính chủ `openwork-mark.svg` (SVG thật, bản `-dark` cho dark mode), nav nổi 3 tab, FAB, skeleton, safe-area, input 16px, touch 44px. **Nút Trở lại `.topbar-back`** ghim trên topbar sticky (min 44px touch, cuộn không trôi). **Đổi giao diện = sửa file này + tokens.md.** |
| `src/components/ui.jsx` | Loading, SkeletonList, Empty (icon + CTA), Banner, ConfirmDialog (thay `confirm()` native), BackButton (dự phòng), `useConfirm()` hook. |
| `src/components/logo.jsx` | OpenWorkMark (img SVG chính chủ, tự đổi -dark theo prefers-color-scheme). |
| `src/components/icons.jsx` | SVG stroke set nội bộ (Folder/File/Image/Upload/Download/Refresh/Back/Plus/Ws/Gear/Clip/Stop/**Screen/Mouse**) — không dùng emoji làm icon. |
| `src/api.js` | Token localStorage + auto-pair từ `#t=`; **multi-tenant: phòng (`owm_tenant`/`owm_tenant_name`) lưu kèm, `tenantHeaders()` gắn `x-owm-tenant` vào mọi request, `sseUrl()` thêm `?_m=`, hash mới `#p=CODE&m=PHÒNG` / `#t=TOKEN&m=PHÒNG` tự lưu phòng; `apiPairTenant(user, pass, label)` → `POST /api/pair/tenant`, xong tự lưu khóa + phòng (KHÔNG lưu mật khẩu)**; `ow()` fetch qua `/api/ow`; unwrap `.data`. **Màn hình (v1.7): `apiScreenInfo()`, `owScreenInput()`, `owScreenStream()`** (fetch stream + reader giải mã frame `[4B len][1B type][payload]` → Blob/meta/lỗi; chặn frame len >8MB). File hai chiều: `owUploadFile()` (giới hạn 40MB, FileReader base64), `bytesToBase64()` (chunk, không tràn stack), `formatBytes()` (Intl vi-VN), `MAX_UPLOAD_BYTES`. |
| `src/app.jsx` | Hash router (`#/`, `#/ws/:id`, `#/ws/:id/chat/:sid`, `#/ws/:id/files`, `#/screen`, `#/settings`), topbar logo + version + **nút Trở lại ghim cố định** theo route (sessions -> #/workspaces, chat/files -> #/ws/:id; nhận event `owm:topback` từ FileViewer), StatusBanners, BottomNav nổi 4 tab (Phiên · Workspace · Màn hình · Cài đặt). |
| `src/pages/home.jsx` | Home = session gần đây GỘP mọi workspace (pattern Happy/Omnara), poll 15s, chấm màu ws (`wsColor`), FAB tạo session trong ws mới nhất. Tạo session KHÔNG gửi title — để server tự sinh tên theo nội dung như desktop. |
| `src/pages/pairing.jsx` | Màn kết nối **3 tab**: **Đăng nhập** (mặc định — user/pass do chủ worker cấp, `apiPairTenant`, nhập 1 lần lưu luôn) · Ghép thiết bị (mã 8 ký tự từ QR, auto-run khi mở link `#p=`) · Nhập token (owm_/owd_ dán trực tiếp). Hero logo gradient. |
| `src/pages/workspaces.jsx` | List card có tile + FAB thêm workspace; sheet tạo mới (POST /workspaces/local) có ô path **+ nút "Duyệt…" mở `FolderPickerSheet`**: duyệt thư mục máy tính qua `/api/fs/ls` (chip nhanh tên folder thật (user/Desktop/Documents/Downloads/ổ đĩa), lên cấp trên, chạm thư mục để đi vào, **"+ Thư mục mới"** (POST `/api/fs/mkdir` rồi chọc thẳng vào), "Chọn thư mục này" điền vào ô path). **create() gửi `folderPath`** (trước đây gửi `path` → server chửi "folderPath is required" — tạo workspace từ điện thoại chưa từng chạy được; server tự mkdir folder chưa tồn tại). |
| `src/pages/sessions.jsx` | Card session có dot busy/idle + FAB tạo session mới (KHÔNG gửi title — server tự sinh tên); nút back đã dọn lên topbar; SSE live. |
| `src/pages/chat.jsx` | Transcript (text/tool/reasoning; markdown tối giản: code block/inline code/list — `MarkdownText`), composer nút send icon gradient + **model picker (bắt buộc)** + **nút kẹp giấy đính kèm file** (upload vào `mobile-uploads/` rồi gửi prompt kèm đường dẫn), offline queue, permission cards (Allow/Deny), SSE events. Nút back dọn lên topbar. **Nút Gửi morph thành nút Dừng** (`busy = running && !sending`, icon `StopIcon`, nền đỏ `.btn-send.stop`, chống double-tap bằng `aborting`, draft giữ nguyên, Ctrl+Enter khi busy = abort) — xóa hẳn nút "Dừng agent" cũ. **Realtime liên tục (v1.6)**: vá chữ streaming vào bong bóng đang chạy (`applyStreamingPatch` — nhận cả delta/snapshot từ `message.part.updated`/`message.updated`), lọc session nới lỏng (`sameSession`: nhận `sessionID/sessionId/properties/message/part` + prefix `ses_`), **poll dự phòng 2.5s chỉ khi `running`** + watchdog 30s chống chết kênh ngầm + `onerror`/mở lại app/có mạng lại đều hỏi lại ngay, chỉ bám đáy khi user đang đọc cuối. **File agent nhắc tới**: `findFileRefsInText()` quét text + tool input/output → `FileRefCard` (Mở/Tải về qua `/files/stat` + `/files/raw`, Xem trong Files) + `linkifyFiles()` biến đường dẫn trong text thành link tải. |
| `src/pages/files.jsx` | Duyệt `/opencode/file` (icon tile, size qua `Intl.NumberFormat` vi-VN); xem/sửa+lưu + upload qua `/files/raw` (base64 chunk qua helper chung, báo tiến trình từng file); xem ảnh (png/jpg/gif/webp/bmp/ico/svg/avif) + **PDF inline (iframe)**; tải về qua `owDownload()` (fetch + Blob + thanh % + Hủy + nút Chia sẻ cho iOS Lưu về Files). Nút back dọn lên topbar, nút Đóng viewer phát event `owm:topback`. |
| `src/pages/screen.jsx` | **Xem + điều khiển máy tính (v1.7)**: stream frame qua `owScreenStream()` — tự nối lại backoff 1s→6s, đổi preset/pause/unmount thì abort (`runIdRef` vô hiệu hóa vòng cũ); ảnh render bằng objectURL (revoke frame cũ). **Mặc định CHỈ XEM** — bật "Đang điều khiển" mới nhận chạm: tap = down+up (click), giữ-kéo = down/move(throttle 60ms)/up (drag); nút Chuột phải/2 nhát bấm tại điểm chạm cuối; cuộn ↑↓; Enter/Esc/⌫/Tab (có sticky Ctrl/Alt/Shift/Win bật sáng → gửi combo rồi tự nhả); ô gõ text gửi nguyên cụm (đi clipboard bên bridge nên tiếng Việt OK). Ẩn app tự pause (`visibilitychange`), preset Nhanh 720/45 · Cân bằng 880/55 · Nét 1100/68. |
| `src/pages/settings.jsx` | Trạng thái bridge (hàng đầu: **Máy đang kết nối** = tên phòng trong `localStorage`), recheck, gỡ pairing (**xóa token + phòng**, ConfirmDialog), hướng dẫn tailscale. |
| `public/sw.js` | App-shell precache (hiện tại `owm-shell-v9`) + navigate fallback (offline mở được shell); không cache `/api/*`. Bump version mỗi lần đổi UI để PWA xóa cache cũ. |
| `wrangler.jsonc` (trong web/) | Worker phụ `openwork-mobile-web` qua `@cloudflare/vite-plugin` — deploy nhanh `cd web && npm run deploy` (build + wrangler). URL chính chủ vẫn là worker `openpocket` (deploy từ `worker/`). |
| `public/icon*.png/svg` + manifest | Icon nền `#111113` + vạch xanh `#0090ff` đặc (đúng logo desktop) 192/512 + maskable (safe zone 80%); manifest có id/scope/lang/orientation/shortcuts. |

## Bảng "triệu chứng → chỗ sửa"

| Triệu chứng | Sửa ở đâu |
|---|---|
| Bridge không tìm thấy openwork-server | `bridge/src/discovery.js` (parse engine-instances, netstat, probe health) |
| Token owner bị 401 dù đã restart | `bridge/src/bootstrap.js` + kiểm tra entry `openwork-mobile-bridge` còn trong `%APPDATA%\openwork\tokens.json` không |
| Mọi thao tác ghi trả `policy_unavailable` "Sign in to verify..." | KHÔNG phải bug bridge — mở OpenWork desktop đăng nhập/verify lại (phiên cloud hết hạn sau restart) |
| Gửi prompt xong message treo, không có reply | Thiếu `model: {providerID, modelID}` trong body — xem `web/src/pages/chat.jsx` (`modelBody()`); engine yêu cầu model tường minh |
| Web gọi API bị 403 "Path not allowed" | `bridge/src/proxy.js` — mảng `ALLOWED` (thêm prefix path mới của openwork-server) |
| POST có body qua bridge bị treo | `bridge/src/proxy.js` (body phải buffer, không stream; abort chỉ khi `res` close + `!writableEnded` — `req` 'close' phát cả khi request kết thúc bình thường) |
| SSE không stream / đứt liên tục | `bridge/src/proxy.js` (isSSE + keepalive) + `index.js` (`server.requestTimeout = 0`) |
| Phone không pair được | `bridge/src/auth.js` + token trong `%APPDATA%\openwork-bridge\config.json`; QR in lúc bridge khởi động |
| Sai danh sách workspace | Do openwork-server; kiểm tra `%APPDATA%\openwork\server.json` |
| Tạo workspace phải gõ tay đường dẫn / muốn sửa trình duyệt thư mục | `bridge/src/fslist.js` (liệt kê + mkdir) + `bridge/src/index.js` (route `/api/fs/ls`, `/api/fs/mkdir`) + `web/src/pages/workspaces.jsx` (`FolderPickerSheet`) |
| Tạo workspace từ điện thoại báo "folderPath is required" | `web/src/pages/workspaces.jsx` `create()` phải gửi `{folderPath}` (đúng tên server đòi) — KHÔNG phải `{path}` |
| Web trắng / không load | Build lại `web/` (`npm run build`) — bridge serve `web/dist` qua `bridge/src/static.js` |
| Muốn đổi màu/tông giao diện | `web/src/styles.css` (`:root` tokens) + đồng bộ `.zcode/skills/pwa-workspace-ui/references/tokens.md` |
| Nút bị che notch/home indicator | Safe-area: `--sat/--sab` trong `web/src/styles.css` (topbar, bottomnav-wrap, FAB, composer) |
| Input bị iPhone tự zoom khi focus | Font-size field < 16px — kiểm tra `web/src/styles.css` (mọi input/textarea/select phải ≥16px) |
| Tunnel không lên / URL public không mở được | `bridge/src/tunnel.js` (download cloudflared, parse URL từ log) |
| Worker trả 503 "bridge_offline" / "bridge_unreachable" | Bridge không heartbeat >20 phút (máy tắt?) hoặc tunnel vừa đổi — đợi ~15-30s cho `src/lookup.js` đăng ký lại. Không tenant: secret `BRIDGE_SECRET` của worker phải trùng `lookupSecret` trong bridge config; có tenant: `lookupSecret` phải trùng secret trong KV `tenant:<user>` |
| Đăng nhập web (tab Đăng nhập) báo "Máy này chưa tham gia phòng nào" | Bridge của người đó chưa join — chạy `openpocket edge join <worker-url>` trên máy của HỌ (route `/api/pair/tenant` trong `bridge/src/index.js` trả 404 `not_joined`) |
| Đăng nhập web báo "Sai tên đăng nhập hoặc mật khẩu" | Worker tự so secret với KV `tenant:<user>` TRƯỚC rồi mới relay — 401 đồng nghĩa (user lạ HOẶC sai pass), không dò ra được phòng tồn tại. Pass đúng mà 401 mãi: kiểm tra JSON trong KV còn nguyên không (`npx wrangler kv key get tenant:<user> --remote` — từng bị cmd Windows nuốt dấu nháy khi script cũ đi qua shell, sửa bằng cách gọi wrangler trực tiếp bằng node như `scripts/tenant.mjs` hiện tại). Pass đúng + 503 "chưa đăng ký/offline" là đúng rồi — máy ấy phải chạy `openpocket edge join` trước |
| Điện thoại bạn này thấy dữ liệu máy bạn kia (không được phép xảy ra) | Kiểm tra `x-owm-tenant` được gắn đủ chưa (`web/src/api.js` — `tenantHeaders()`/`sseUrl()`) và worker chọn slot đúng (`worker/src/index.js` — header `x-owm-tenant` / `?_m=` / `machine:main`); worker không giữ key nên sai phòng chỉ có thể là sai/gắn thiếu tenant |
| Qua worker response thành ký tự lạ / body hỏng với curl | Edge CF tự nén tunnel response — đã sửa trong `worker/src/index.js` relay: subrequest xin `accept-encoding: identity` + bóc `content-encoding: gzip/deflate` bằng `DecompressionStream`; nếu tái diễn kiểm tra 2 chỗ này |
| Điện thoại mất kết nối sau khi restart máy | **Không còn là vấn đề** (worker tự tìm lại bridge qua heartbeat). Nếu mất hẳn: quota Workers free (100k/ngày) hoặc bridge chưa chạy |
| OpenWork update đổi format dữ liệu | Adapter cô lập: `discovery.js` (engine-instances.json), `bootstrap.js` (tokens.json) |
| Session mới toàn tên "Mobile" | `web/src/pages/home.jsx` + `sessions.jsx` (`newSession()`) từng gửi cứng `title: "Mobile"` — đã bỏ, tạo session để trống body `{}` cho server tự sinh tên |
| Nút Tải về / ảnh trong app báo 401 với token master | `bridge/src/index.js` từng gọi `isAuthorized()` (chỉ nhìn header) dù `requestToken()` đã trích `?_t=` — đã sửa sang `isTokenAuthorized(token, ...)` công nhận cả hai; test `?_t= query token counts as master token` trong `bridge/test/bridge.test.js` |
| Upload file lớn treo / văng app | `files.jsx` từng `btoa(String.fromCharCode(...spread))` tràn stack — đã thay bằng `fileToBase64()` (FileReader) + `bytesToBase64()` chunk trong `web/src/api.js`; giới hạn rõ `MAX_UPLOAD_BYTES` 40MB (base64 phồng ~37%, proxy chặn 64MB) |
| Muốn nhận file agent tạo mà không mò sang tab Files | Engine không có part file riêng — agent ghi file qua tool `write` rồi nhắc đường dẫn trong text. `chat.jsx` (`findFileRefsInText` + `FileRefCard` + `linkifyFiles`) tự hiện thẻ Mở/Tải về ngay trong tin nhắn |
| Muốn gửi file/ảnh từ điện thoại cho agent | Nút kẹp giấy trong composer `chat.jsx`: upload vào `mobile-uploads/` qua `owUploadFile()` rồi gửi prompt kèm đường dẫn (engine không nhận part file riêng) |
| Tải file không hiện % / không resume | `bridge/src/proxy.js` từng chỉ forward 5 header — đã thêm `content-length/content-range/accept-ranges` |
| Bấm Tải về trên iOS mở file trong tab thay vì lưu / file lớn không biết tiến trình | `web/src/api.js` (`owDownload()`: fetch header auth + đọc stream hiện % + AbortController) + `files.jsx` (nút Tải về Blob + thanh progress + Hủy + nút Chia sẻ qua `navigator.share` để iOS Lưu về Files) + `bridge/src/proxy.js` (tự gắn `content-disposition: attachment` fallback từ `?path=` khi upstream quên); test `filenameFromQuery` trong `bridge/test/bridge.test.js` |
| Nút Trở lại Sessions / Workspace bị trôi theo nội dung khi cuộn | `web/src/app.jsx` + `web/src/styles.css` — chuyển nút Trở lại lên `topbar` (vốn đã sticky ở đỉnh, kèm blur và safe-area), gỡ `BackButton` trôi trong `page-head` ở chat, sessions, files. FileViewer mượn topbar qua event `owm:topback` |
| Sửa code web nhưng điện thoại vẫn hiện bản cũ | Phải build `npm run build` trong `web/` rồi deploy worker: `cd worker && npx wrangler deploy` (worker chính chủ `openpocket`, nhớ `--config` nếu chạy từ web/) hoặc nhanh hơn `cd web && npm run deploy` (worker phụ `openwork-mobile-web`). Đã bump `CACHE = "owm-shell-v5"` trong `web/public/sw.js` để PWA kích hoạt xóa cache cũ |
| Bridge không tự chạy khi đăng nhập Windows | `openpocket autostart --enable [--with-openwork]` tạo task `OpenPocketBridge` (ONLOGON) trong Task Scheduler — xem `bridge/src/autostart.js` + `bridge/bin/openpocket.js`. Cần quyền admin lần đầu; xem trạng thái bằng `--status` |
| Điện thoại báo mất server mà OpenWork chưa mở | Bấm nút "Bật OpenWork trên máy tính" (banner đỏ + Cài đặt) → `POST /api/openwork/wake` → `bridge/src/openwork-launch.js` tự tìm exe và mở app. Tìm không thấy exe thì set `openworkExe` trong config hoặc env `OPENWORK_EXE`. Máy tắt hẳn/ngủ sâu thì chịu, phải bật máy trước |
| Muốn bấm nút Gửi để ngắt agent như ChatGPT/Gemini | `chat.jsx` — nút Gửi tự morph thành nút Dừng đỏ (`busy = running && !sending`) khi agent chạy; bấm lại gọi `abort()`, draft giữ nguyên |
| Chat đứng yên, phải thoát ra vào lại mới thấy tin mới | `chat.jsx` từng chỉ nghe SSE rồi debounce 500ms fetch full, lọc đúng `data.sessionID === sessionId`, không `onerror`/fallback — SSE chết ngầm (mobile ngủ, đổi mạng, tunnel đổi, server restart) là đóng băng. Đã sửa v1.6: vá chữ streaming trực tiếp vào bong bóng (`applyStreamingPatch`), nới lọc session (`sameSession`), poll dự phòng 2.5s chỉ khi running + watchdog 30s + refetch khi SSE lỗi/mở app lại/có mạng |
| Màn hình trong tab Màn hình đen / đứng im / báo lỗi chụp | `bridge/src/screen.js` `captureOnce()` — màn hình khóa/UAC/secure desktop không chụp được (frame error type 3 sẽ hiện banner); không ai xem 90s bridge tự dừng chụp là bình thường (xem lại là tự chạy). Bridge phải restart sau khi upgrade code (`openpocket stop && openpocket start`) |
| Gõ tiếng Việt bị sai ký tự (vd "chào" thành "OOOOO") | TEXT phải đi **clipboard + Ctrl+V** trong `bridge/src/desktop-input.cs` (`DoText`) — gõ phím Unicode thẳng (KEYEVENTF_UNICODE) bị IME Unikey/Telex ăn. ĐỪNG chuyển lại đường Unicode |
| Bấm/chạm trong tab Màn hình lệch vị trí | DPI: daemon `SetProcessDPIAware` + PING trả dims theo góc nhìn daemon, bridge tin daemon (`screen.js` `ensureDaemon`); tọa độ web gửi phải chuẩn hóa 0..1 theo khung ảnh (`screen.jsx` `normFromEvent`) |
| Stream nhanh đứt / treo ảnh | Web tự nối lại backoff (`screen.jsx` effect + `runIdRef`); viewer chậm bị bridge ngắt ở 3MB pending — cả hai chủ động reconnect; nếu loop chết xem `screen.js` `wakeLoop()` errorStreak |
| Tab Màn hình 4 tab nav bị chật máy nhỏ | `styles.css` `.bottomnav` (max-width 420px, 4 nút); icon `ScreenIcon` trong `icons.jsx` |

## Route API của bridge (phone gọi)

| Route | Auth | Chức năng |
|---|---|---|
| `GET /api/state` | owm_/owd_ | Trạng thái bridge + server + token + engine + thiết bị hiện tại + `edge: {tenant, machineName}` |
| `POST /api/pair` | **không cần** (rate-limit 10/phút/IP) | Ghép thiết bị bằng mã 30 phút → trả khóa owd_ vĩnh viễn |
| `POST /api/pair/tenant` | **không cần** (rate-limit chung, 10/phút/IP) | Đăng nhập multi-tenant: body `{user, secret, label}` — so với `lookupTenant`/`lookupSecret` trong config → trả `{token, device, tenant, machineName}`. Chưa join → 404 `not_joined`; sai → 401 `invalid_credentials` |
| `GET /api/devices` · `DELETE /api/devices/:id` | owm_/owd_ | Danh sách thiết bị đã ghép + thu hồi |
| `POST /api/recheck` | owm_ | Ép discovery lại |
| `POST /api/openwork/wake` | owm_/owd_ (rate-limit 5/phút/IP) | Mở OpenWork desktop trên máy tính (đang chạy rồi → `alreadyRunning`; mới mở → `launched`) |
| `GET /api/fs/ls?path=` | owm_/owd_ | Duyệt thư mục máy tính. Không `path` → `{isWindows, home, roots[], quick[]}`; có `path` → `{path, parent, name, dirs[]}` (chỉ thư mục). Lỗi: 404 ENOENT/ENOTDIR, 403 EACCES — message tiếng Việt |
| `POST /api/fs/mkdir` | owm_/owd_ | Tạo thư mục mới `{dir, name}` → `{path, name}`. 400 EEXIST/EINVAL (trùng tên/ký tự cấm), 403 EACCES |
| `GET /api/screen/stream?w=&q=` | owm_/owd_ | Stream binary JPEG liên tục (frame `[4B len][1B type][payload]`); tối đa 3 viewer; chậm quá 3MB buffer bị ngắt (client tự nối lại); không ai xem 90s tự dừng chụp |
| `GET /api/screen/info` | owm_/owd_ | `{available, screen:{width,height}, viewers}` — web dùng preflight |
| `POST /api/screen/input` | owm_/owd_ (rate-limit 40/giây/IP — drag phát move liên tục) | Điều khiển: `{type:"click"\|"rclick"\|"dbl"\|"down"\|"up"\|"move"\|"wheel"\|"key"\|"combo"\|"text", x?,y? (0..1), ...}` qua daemon C# |
| `/api/ow/<path>` | owm_ (header hoặc `?_t=` cho GET) | Proxy openwork-server. Whitelist: `/workspaces*`, `/workspace/:id/(events|session-groups|files|opencode/*|engine/reload|artifacts|inbox)`, `/approvals*`, `/files/sessions/*`, `/experimental/(ui-control|extensions)`, `/status`, `/capabilities`, `/whoami`, `/health` |

## Endpoint openwork-server hay dùng (gọi qua `/api/ow/`)

| Endpoint | Chức năng | Ghi chú shape |
|---|---|---|
| `GET /workspaces` | Danh sách ws | `{workspaces:[{id,name,path,workspaceType}...]}` |
| `POST /workspaces/local` | Tạo ws `{path, name}` | auth "host" = owner bearer OK |
| `GET /workspace/:id/opencode/session` | Sessions | `{data:[{id,title,time:{updated}}]}`, sort theo updated |
| `GET .../opencode/session/status` | Busy/idle map | `{ses_id:{type}}` (có thể wrap .data) |
| `GET .../opencode/session/:sid/message` | Transcript | `{data:[{info:{id,role,time}, parts:[{type,text|tool|reasoning}]}]}` — **role nằm trong `.info`** |
| `POST .../opencode/session/:sid/prompt_async` | Gửi prompt | body `{parts:[{type:"text",text}], model:{providerID,modelID}}` → 204. **Model là object, bắt buộc** |
| `POST .../opencode/session/:sid/abort` | Hủy | |
| `DELETE .../opencode/session/:sid` | Xóa session | |
| `GET .../opencode/config/providers` | Models khả dụng | `{providers:[{id,name,models:{id:{name}}}]}` |
| `GET .../opencode/file?path=` | List thư mục | `{data:[{name,path,type,size}]}` |
| `GET .../opencode/event` | SSE engine | event có tên (session.updated, message.updated, message.part.updated, permission.updated) |
| `GET/POST /workspace/:id/files/raw` | Đọc/ghi file bất kỳ | POST body `{path, dataBase64}` → `{ok:true,path,bytes}` |
| `GET /workspace/:id/files/stat?path=` | Kiểm tra file | `{ok,exists,path}` |
| `GET/POST /approvals`, `POST /approvals/:id` | Permission inbox | |

## Dữ liệu OpenWork mà bridge phụ thuộc

| File | Ý nghĩa | Rủi ro khi OpenWork update |
|---|---|---|
| `%APPDATA%\openwork\engine-instances.json` | Port + pid engine + ownerPid | Đổi tên field → sửa `discovery.js` |
| `%APPDATA%\openwork\tokens.json` | Token store (sha256) | Server load 1 lần lúc khởi động → token mới phải restart mới nhận |
| `%APPDATA%\openwork\server.json` | Registry workspaces | Bridge chỉ đọc gián tiếp qua API |
| runtime config (trong runtime.sqlite) | managedPolicy + providers | Sign-in cloud hết hạn → mọi mutation bị chặn tới khi mở app verify |

## Các quyết định/knowledge đáng nhớ

- **Node 18+ `req` 'close' không đồng nghĩa client ngắt** — nó phát cả khi request kết thúc bình thường; abort upstream phải dựa vào `res.on('close')` + `!res.writableEnded`.
- **POST body qua proxy phải buffer** — stream (chunked) làm openwork-server treo không hồi đáp.
- opencode engine trong OpenWork spawn bằng `OPENCODE_SERVER_USERNAME/PASSWORD` random mỗi lần — credential thật chỉ nằm trong memory openwork-server, **registry authProbe là giá trị stale** → đừng cố gọi thẳng engine.
- Đã E2E full 2026-09-12: tạo session → prompt (model `opencode/nemotron-3-ultra-free`) → reply "OK" sau ~35s → delete; ghi/đọc file `bridge-test.txt` OK.
- **Quick Tunnel (v1.1):** học từ [9Remote](https://github.com/decolua/9remote) — họ cũng dùng quick tunnel, nhưng thêm: tự động hóa cloudflared + QR lại khi URL đổi + (họ có) edge lookup Workers map machineId→URL. Mình đã làm 2 cái đầu; cái thứ 3 (Workers) để sau nếu cần auto-rediscovery hoàn toàn. Đã test public URL qua CF edge: /api/state + web + workspaces đều 200.
- **Multi-tenant "tòa nhà nhiều phòng" (v1.7):** một web chung cho nhiều máy — mỗi bridge một phòng (KV `machine:<id>`), tài khoản `tenant:<id>` do chủ worker cấp bằng `worker/scripts/tenant.mjs` (cùng 1 cặp user/pass dùng ở bridge `edge join` lẫn web tab Đăng nhập). Web lưu khóa vĩnh viễn + tên phòng, KHÔNG lưu mật khẩu; worker không giữ khóa nào — sai phòng = không có gì để đánh cắp. E2E chuỗi thật 2026-09-13: worker → tunnel → bridge cấp khóa, `/api/state` xuyên chuỗi OK, máy không phòng vẫn 503 tách bạch. Máy nhà giữ luồng `machine:main` không đổi gì.
- **KV free là giới hạn cứng ~1000 ghi/ngày** → heartbeat giãn 60s → 15 phút (stale 20 phút), ~96 ghi/ngày/phòng → đủ ~10 phòng. Bridge chết vẫn báo lỗi ngay qua `bridge_unreachable` (fetch hụt), nên stale lâu chỉ làm chậm thông báo "offline", không ảnh hưởng trải nghiệm chính.
- **EventSource không set được header** → phòng đi kèm `?_m=` trên URL SSE (song song `?_t=` của token) — `web/src/api.js` `sseUrl()` + worker `url.searchParams.get("_m")`.
- **Xem/điều khiển màn hình (v1.7) học từ 9remote v2.58 thật (mổ xẻ npm global trên máy):** họ chụp bằng `node-screenshots` + nén `sharp` (mình copy nguyên 2 lib này), đẩy tile có ack qua WebRTC (mình thay bằng push-stream JPEG nguyên khung qua HTTP — đủ dùng, không cần TURN), điều khiển bằng robotjs (mình thay bằng daemon C# csc — ít rủi ro native), gõ text đi **clipboard** (`clipboard-attach` event của họ xác nhận cùng hướng). Ảnh không bao giờ chạm đĩa ở cả hai. `toRawSync()` trả **RGBA khớp PNG decode** (đã đối chiếu từng byte) nên sharp raw channels:4 dùng thẳng không sợ đảo màu. Capture 81ms + resize/JPEG 41ms trên 2880x1800 → 3-4 hình/s thực tế, JPEG ~8-20KB tùy preset.
- **Notepad test bị race foreground khi máy có người dùng thật**: spawn notepad từ nền không chiếm focus (Windows foreground-lock) — mẹo ALT-tap + `SetForegroundWindow` (script `dbg-screen.mjs`), LUÔN kiểm tra foreground đúng process trước khi gõ (lần lỡ dán "ĐÀ-NẶNG oà oá" vào ô chat ZCode vì quên check).

## Chạy

```bash
# bridge
cd bridge && npm install && npm start     # QR + mã pairing in ra terminal
# web (build ra web/dist do bridge serve)
cd web && npm install && npm run build
# unit test
cd bridge && npm test
# E2E live (cần OpenWork đang chạy + đã qua bước restart 1 lần)
node bridge/scripts/e2e-live.mjs ws_3d8246222830 opencode nemotron-3-ultra-free
# remote: tailscale serve --bg 8788 + set OPENWORK_PUBLIC_URL rồi chạy lại bridge
# multi-tenant: cấp/xóa phòng trên KV thật (cần wrangler đã đăng nhập)
cd worker && node scripts/tenant.mjs add nam "Máy của Nam"   # hoặc: list / revoke nam
```
