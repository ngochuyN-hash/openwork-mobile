# CODE_SUMMARY — OpenWork Mobile

> Tài liệu tra nhanh "gặp lỗi thì sửa ở đâu". Cập nhật sau mỗi milestone.
> Cập nhật lần cuối: 2026-09-12 (v1 hoàn thiện, đã E2E qua bridge thật)
>
> 📌 **Quy tắc (yêu cầu của chủ dự án):** mỗi khi thay đổi code/cấu trúc/hành vi,
> PHẢI cập nhật đồng thời file này VÀ `README.md` trong cùng commit.

## Kiến trúc tổng thể (1 dòng)

Điện thoại mở PWA → (HTTPS qua `tailscale serve`) → **openwork-bridge** (Node, 127.0.0.1:8788) → **openwork-server** (API có sẵn trong OpenWork desktop, port động) → opencode engine sidecar.

```
[Phone: PWA]  ←REST+SSE→  [bridge :8788]  ←proxy whitelist, inject Bearer owt_ owner→  [openwork-server :62222*]  →  [opencode engine :49363*]
                                                                                              (*port ĐỔI mỗi lần chạy OpenWork)
```

## Vì sao kiến trúc này

- OpenWork desktop (Electron) chạy sẵn **openwork-server** với API đầy đủ: workspaces, session-groups, approvals, files đọc/ghi, SSE events, và **proxy mount `/workspace/:id/opencode/*`** (gửi message `prompt_async`, abort, permission reply...). Bridge KHÔNG viết lại API — chỉ chuyển tiếp có chọn lọc.
- openwork-server auth bằng `Authorization: Bearer owt_...` (scope `owner` = full). Token lưu **sha256** trong `%APPDATA%\openwork\tokens.json`, server chỉ load 1 lần lúc khởi động → bridge tự mint token vào file này, restart OpenWork **đúng 1 lần** là dùng vĩnh viễn.
- Port openwork-server động (62222 hôm nay) → bridge tự tìm: đọc `engine-instances.json` lấy `ownerPid` → `netstat -ano` lấy các port của pid đó → probe `GET /health` (payload có `opencodeVersion` là đúng server).
- Tìm thấy tất cả các hiểu lầm về API bằng cách soi `app.asar` (extract bằng `npx @electron/asar extract`) — `server/dist/*.js` là code openwork-server, `app-dist/assets/app-*.js` là SPA chính chủ (ground truth cho request/response shape).

## Bản đồ file

### bridge/ (Node.js ≥20, deps chỉ qrcode-terminal)

| File | Trách nhiệm |
|---|---|
| `src/index.js` | Entry: bootstrap token → discovery loop (5s + fs.watch) → HTTP server (API + static). In QR pairing. Lưới an toàn uncaughtException. |
| `src/config.js` | Config runtime (mobileToken `owm_`, ownerToken `owt_`, port, publicUrl). Nằm NGOÀI repo: `%APPDATA%\openwork-bridge\config.json`. |
| `src/bootstrap.js` | Mint/append token owner vào `%APPDATA%\openwork\tokens.json` (atomic + .bak). hash = sha256 hex thuần, id cố định `openwork-mobile-bridge`. |
| `src/discovery.js` | Đọc `engine-instances.json` (ownerPid) → parse netstat → probe `/health` → check `/whoami` (token active). |
| `src/proxy.js` | Reverse proxy `/api/ow/*` → openwork-server. Whitelist sau khi **normalize dot-segments**, method allowlist, inject Bearer owner, **body buffer (cap 64MB)**, stream response + SSE keepalive 20s. |
| `src/auth.js` | Phone → bridge: `owm_` token (header) + `?_t=` (chỉ GET, cho EventSource/img). timingSafeEqual. |
| `src/static.js` | Serve `web/dist` (SPA fallback index.html). |
| `src/paths.js` | Vị trí `%APPDATA%\openwork` (env `OPENWORK_DIR` override cho test). |
| `test/bridge.test.js` | Unit: netstat parse, whitelist + traversal, auth, hash. `npm test` |
| `scripts/e2e-live.mjs` | E2E: tạo session → prompt_async → poll reply → delete. `node scripts/e2e-live.mjs <wsId> <providerId> <modelId>` |
| `scripts/dbg-prompt.mjs` | Debug prompt: dump status + parts mỗi 5s. |

### web/ (Preact + Vite → dist ~40KB gzip 14KB)

| File | Trách nhiệm |
|---|---|
| `src/api.js` | Token localStorage + auto-pair từ `#t=`; `ow()` fetch qua `/api/ow`; `sseUrl()` thêm `?_t=`; unwrap `.data`. |
| `src/app.jsx` | Hash router (`#/`, `#/ws/:id`, `#/ws/:id/chat/:sid`, `#/ws/:id/files`, `#/settings`), StatusBanners, BottomNav. |
| `src/pages/pairing.jsx` | Nhập mã `owm_...` lần đầu. |
| `src/pages/workspaces.jsx` | List workspaces + dialog tạo mới (POST /workspaces/local). |
| `src/pages/sessions.jsx` | Session list + status busy/idle + live SSE + tạo session mới. |
| `src/pages/chat.jsx` | Transcript (parts: text/tool/reasoning), composer + **model picker (bắt buộc)**, abort, offline queue, permission cards (Allow/Deny), SSE events. |
| `src/pages/files.jsx` | Duyệt qua `/opencode/file`; đọc/preview + **sửa+lưu + upload** qua `/files/raw` (base64); tải file về. |
| `src/pages/settings.jsx` | Trạng thái bridge, recheck, gỡ pairing, hướng dẫn tailscale. |
| `public/sw.js` | App-shell precache; không cache `/api/*`. |

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
| Web trắng / không load | Build lại `web/` (`npm run build`) — bridge serve `web/dist` qua `bridge/src/static.js` |
| OpenWork update đổi format dữ liệu | Adapter cô lập: `discovery.js` (engine-instances.json), `bootstrap.js` (tokens.json) |

## Route API của bridge (phone gọi)

| Route | Auth | Chức năng |
|---|---|---|
| `GET /api/state` | owm_ | Trạng thái bridge + server + token + engine |
| `POST /api/recheck` | owm_ | Ép discovery lại |
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
```
