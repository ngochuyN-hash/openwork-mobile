# CODE_SUMMARY — OpenWork Mobile

> Tài liệu tra nhanh "gặp lỗi thì sửa ở đâu". Cập nhật sau mỗi milestone.
> Cập nhật lần cuối: 2026-09-12 (milestone: scaffold + bridge proxy)

## Kiến trúc tổng thể (1 dòng)

Điện thoại mở PWA → (HTTPS qua `tailscale serve`) → **openwork-bridge** (Node, 127.0.0.1:8788) → **openwork-server** (API có sẵn trong OpenWork desktop, port động) → opencode engine sidecar.

```
[Phone: PWA]  ←SSE+REST+JSON→  [bridge :8788]  ←proxy có whitelist, inject Bearer owt_ owner→  [openwork-server :62222*]  →  [opencode engine :49363*]
                                                                                                 (*port ĐỔI mỗi lần chạy OpenWork)
```

## Vì sao kiến trúc này

- OpenWork desktop (Electron) chạy sẵn **openwork-server** với API đầy đủ: workspaces, session-groups, approvals (permission), files đọc/ghi, SSE events, và **proxy mount `/workspace/:id/opencode/*`** (gửi message `prompt_async`, abort, permission reply...). Bridge KHÔNG viết lại API — chỉ chuyển tiếp có chọn lọc.
- openwork-server auth bằng `Authorization: Bearer owt_...` (scope `owner` = full). Token lưu **sha256** trong `%APPDATA%\openwork\tokens.json`, server chỉ load 1 lần lúc khởi động → bridge tự mint token của mình vào file này, user restart OpenWork **đúng 1 lần** là dùng vĩnh viễn.
- Port openwork-server động (62222 hôm nay) → bridge tự tìm: đọc `engine-instances.json` lấy `ownerPid` → `netstat -ano` lấy các port của pid đó → probe `GET /health` (payload có trường `opencodeVersion` là đúng server).

## Bản đồ file

| File | Trách nhiệm |
|---|---|
| `bridge/src/index.js` | Entry: bootstrap token → discovery loop → HTTP server (API + static). In QR pairing lúc khởi động. |
| `bridge/src/config.js` | Config runtime bridge (mobileToken `owm_`, ownerToken `owt_`, port, publicUrl). Nằm ngoài repo: `%APPDATA%\openwork-bridge\config.json`. |
| `bridge/src/bootstrap.js` | Mint/append token owner vào `%APPDATA%\openwork\tokens.json` (atomic write + .bak). Format hash = sha256 hex thuần. |
| `bridge/src/discovery.js` | Đọc `engine-instances.json`, parse netstat, probe `/health`, check `/whoami` (token active chưa). |
| `bridge/src/proxy.js` | Reverse proxy `/api/ow/*` → openwork-server. Whitelist path + method, inject Bearer owner, stream 2 chiều (SSE keepalive 20s). |
| `bridge/src/auth.js` | Xác thực phone → bridge bằng `owm_` token (timingSafeEqual). |
| `bridge/src/static.js` | Serve `web/dist` (SPA fallback index.html). |
| `bridge/src/paths.js` | Vị trí thư mục dữ liệu OpenWork (`OPENWORK_DIR` override cho test). |
| `web/src/*` | PWA Preact — xem thêm trong web/README khi hoàn thiện. |

## Bảng "triệu chứng → chỗ sửa"

| Triệu chứng | Sửa ở đâu |
|---|---|
| Bridge không tìm thấy openwork-server | `bridge/src/discovery.js` (parse `engine-instances.json`, netstat, probe `/health`) |
| Token owner bị từ chối (401 dù đã restart) | `bridge/src/bootstrap.js` (hash/format token) + kiểm tra `%APPDATA%\openwork\tokens.json` còn entry `openwork-mobile-bridge` không |
| Web gọi API bị 403 "Path not allowed" | `bridge/src/proxy.js` — mảng `ALLOWED` (thêm prefix path mới của openwork-server) |
| SSE không stream / đứt liên tục | `bridge/src/proxy.js` (phần `isSSE`, keepalive) + `index.js` (`server.requestTimeout = 0`) |
| Phone không pair được | `bridge/src/auth.js` + token trong `%APPDATA%\openwork-bridge\config.json`; QR in lúc bridge khởi động |
| Sai danh sách workspace | Không phải bridge — do openwork-server; kiểm tra `%APPDATA%\openwork\server.json` |
| Web không load / trắng | Build lại `web/` (`npm run build`) — bridge serve `web/dist` qua `bridge/src/static.js` |
| OpenWork update đổi format dữ liệu | Các adapter cô lập: `discovery.js` (engine-instances), `bootstrap.js` (tokens.json) — chỉ sửa 2 file này |

## Route API của bridge (phone gọi)

| Route | Auth | Chức năng |
|---|---|---|
| `GET /api/state` | owm_ | Trạng thái bridge + server + token |
| `POST /api/recheck` | owm_ | Ép discovery lại (dùng sau khi restart OpenWork) |
| `/api/ow/<path>` | owm_ | Proxy sang openwork-server (inject Bearer owner). Whitelist: `/workspaces*`, `/workspace/:id/(events|session-groups|files|opencode/*|engine/reload|artifacts|inbox)`, `/approvals*`, `/files/sessions/*`, `/experimental/ui-control*`, `/status`, `/capabilities`, `/whoami` |

## Endpoint openwork-server hay dùng (qua `/api/ow/`)

| Endpoint | Chức năng |
|---|---|
| `GET /workspaces` · `POST /workspaces/local` | Danh sách / tạo workspace |
| `GET /workspace/:id/session-groups` · `.../events` (SSE) | Session list (grouped) + events |
| `GET /workspace/:id/opencode/session` | Danh sách session thô của engine |
| `POST /workspace/:id/opencode/session/:sid/prompt_async` | Gửi prompt (204, theo dõi qua SSE) |
| `POST /workspace/:id/opencode/session/:sid/abort` | Hủy session đang chạy |
| `GET /workspace/:id/opencode/session/:sid/message` | Đọc transcript |
| `GET/POST /approvals` · `POST /approvals/:id` | Permission inbox + duyệt |
| `GET/POST /workspace/:id/files/content` · `GET /files/raw` | Đọc / ghi file trong workspace |

## Dữ liệu OpenWork mà bridge phụ thuộc

| File | Ý nghĩa | Rủi ro khi OpenWork update |
|---|---|---|
| `%APPDATA%\openwork\engine-instances.json` | Port + pid engine + ownerPid | Đổi tên field → sửa `discovery.js` |
| `%APPDATA%\openwork\tokens.json` | Token store (sha256) | server loads 1 lần lúc khởi động → token mới phải restart mới nhận |
| `%APPDATA%\openwork\server.json` | Danh sách workspace | bridge chỉ đọc gián tiếp qua API |

## Chạy

```bash
# bridge
cd bridge && npm install && npm start
# web (build ra ../web/dist do bridge serve)
cd web && npm install && npm run build
# remote: tailscale serve --bg 8788  (máy tính) rồi mở URL tailscale trên điện thoại
```
