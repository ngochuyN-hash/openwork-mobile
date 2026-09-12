# OpenWork Mobile

Quản lý **sessions, workspaces và files** của [OpenWork](https://github.com/different-ai/openwork) desktop **từ điện thoại, ở bất kỳ đâu** — web app (PWA) tự kết nối mỗi khi mở trang, không cần APK, chạy được cả iOS lẫn Android, chi phí **0 đồng**.

## Giới thiệu dự án

OpenWork là app desktop (Electron, opensource) để chạy các AI coding agent — nhưng chỉ dùng được tại máy tính. Dự án này thêm một "cửa sau" chính chủ cho điện thoại:

| Yêu cầu ban đầu | Cách đáp ứng |
|---|---|
| Quản lý session & workspace đang có | Bridge nối thẳng vào API có sẵn của openwork-server chạy trong OpenWork desktop |
| Quản lý file khi ra ngoài | File manager: duyệt / xem / **sửa + lưu** / upload / tải về |
| Chạy nhẹ | Bridge = 1 tiến trình Node, ~0 dependency; web app ~42KB (gzip 15KB); không DB riêng |
| Tương tác từ xa, giữ kết nối | SSE streaming + auto-reconnect + offline queue (tin nhắn soạn offline tự gửi khi có mạng) |
| Không APK, iOS dùng được | Web/PWA — mở link là tự kết nối, "Thêm vào màn hình chính" như app thật |
| Miễn phí hoàn toàn | Cloudflare Quick Tunnel (không cần tài khoản) + model free của OpenCode Zen |

**Nguyên tắc thiết kế:** không viết lại những gì OpenWork đã có. Bridge chỉ là lớp mỏng: tìm server → giữ token → chuyển tiếp có chọn lọc + serve web. OpenWork update thì mình chỉ sửa 2 adapter (đã ghi rõ trong [CODE_SUMMARY.md](./CODE_SUMMARY.md)).

```
Điện thoại (PWA, 4G/5G bất kỳ đâu — KHÔNG cần cài app nào)
   │  HTTPS qua Cloudflare Quick Tunnel (bridge tự chạy, 0đ, không cần tài khoản)
   ▼
openwork-bridge  (máy tính, Node.js, 127.0.0.1:8788)
   │  Bearer token owner (bridge tự mint, không lộ ra điện thoại)
   ▼
openwork-server  (API có sẵn trong OpenWork desktop, port động)
   ▼
opencode engine  →  sessions · models · files
```

## Tính năng (v1)

- 📁 **Workspaces**: danh sách live, tạo workspace mới (FAB gradient); khi tạo **bấm nút "Duyệt…" để chọn thư mục trên máy tính** (chip nhanh tên folder thật, chọc ổ đĩa → thư mục từng cấp, **"+ Thư mục mới"** tạo luôn chỗ ở cho project chưa có) — không cần gõ tay đường dẫn; folder chưa tồn tại cũng được, server tự tạo
- 💬 **Sessions**: danh sách (busy/idle realtime), tạo mới, xem transcript đầy đủ (text/tool/reasoning, markdown + code block), gửi prompt (chọn model); **chữ agent chảy dần từng đoạn ngay khi đang trả lời**, mất mạng/khóa màn hình/đổi Wifi mở lại tự bắt kịp không cần thoát ra vào lại; khi agent đang chạy, **nút Gửi biến thành nút Dừng đỏ (■)** — bấm lại để ngắt như ChatGPT/Gemini, draft đang gõ được giữ nguyên
- 🔐 **Permissions**: duyệt Allow/Deny ngay trên điện thoại khi agent xin phép
- 🗂 **Files**: duyệt cây thư mục, xem/sửa + lưu file text, xem ảnh **+ PDF**, upload từ điện thoại, tải file về (hiện % + Hủy + nút Chia sẻ để iOS Lưu về Files)
- 🖥 **Màn hình (v1.7, học cơ chế 9Remote)**: xem màn hình máy tính trực tiếp trên điện thoại (~3-4 hình/s, ảnh nén JPEG không lưu đĩa) và **điều khiển được luôn** — chạm = click, giữ kéo = kéo thả, nút chuột phải/cuộn/Enter/Esc, tổ hợp Ctrl/Alt/Shift/Win, **gõ tiếng Việt từ điện thoại** (đi đường clipboard nên không bị IME máy tính ăn chữ). Mặc định ở chế độ **Chỉ xem** — muốn điều khiển phải bật công tắc. Chi tiết bên dưới 👇
- 📎 **File trong chat (2 chiều)**: file agent nhắc tới hiện **thẻ Mở/Tải về + Xem trong Files** ngay trong tin nhắn; nút **kẹp giấy** trong khung chat để gửi file/ảnh từ điện thoại cho agent đọc
- 📴 **Offline queue** + auto-reconnect; PWA cài màn hình chính iOS/Android (icon 192/512 + maskable đủ chuẩn cài Android, apple-touch-icon cho iOS)

## Giao diện (v4 "desktop-first")

Nhân bản giao diện **OpenWork desktop thật** (soi trực tiếp app đang chạy + CSS
`app-dist`): **light/dark tự theo hệ thống**, nền sáng `#f8fafc` / tối `#111113`,
**nút chính đen (light) / trắng (dark)** như nút "Add skill" trên desktop,
**chấm màu nhận diện workspace** (mỗi ws một màu cố định), **logo lục giác chính chủ** `openwork-mark.svg` (SVG gốc, có bản dark). Cấu trúc học từ các app điều khiển agent
(Happy, Omnara): mở app là thấy **Phiên gần đây gộp mọi workspace**, nav nổi
3 tab (Phiên · Workspace · Cài đặt), FAB tạo session. **Nút Trở lại (Sessions, Workspace, Đóng) luôn ghim cố định trên topbar** (vốn sticky trên đỉnh màn hình kèm blur và safe-area), cuộn nội dung dài đến đâu cũng không trôi mất. Theo skill nội bộ
`pwa-workspace-ui` (`.zcode/skills/`): input 16px chống iOS zoom, nút ≥44px,
safe-area, skeleton loading, `prefers-reduced-motion`, icon SVG toàn bộ.

## Yêu cầu

- Máy tính Windows đang chạy **OpenWork desktop** + **Node.js ≥ 20**
- Điện thoại: **không cần cài gì** (mở link qua tunnel công cộng; muốn URL cố định thì cài Tailscale tùy chọn)

## Cài đặt (máy tính — làm 1 lần)

```bash
# 1. Bridge
cd bridge && npm install

# 2. Web app
cd ../web && npm install && npm run build

# 3. Chạy bridge
cd ../bridge && npm start
```

Lần đầu chạy, bridge tự mint token vào OpenWork và in ra **QR chứa mã ghép một lần (sống 30 phút)**.

> ⚠️ Sau lần chạy bridge **đầu tiên**, restart OpenWork desktop **đúng 1 lần** để token có hiệu lực (OpenWork chỉ nạp `tokens.json` lúc khởi động). Bridge tự nhận biết — làm 1 lần thôi.

## Dùng trên điện thoại (không cần cài gì)

Bridge khởi động xong sẽ **tự mở Cloudflare Quick Tunnel** (tự tải cloudflared lần đầu, ~50MB) và in ra terminal:
- **URL public** dạng `https://xxx.trycloudflare.com` kèm **QR chứa mã ghép một lần (30 phút)**
- Mở link đó trên điện thoại (4G ở đâu cũng được) → app **tự ghép** → nhận **khóa vĩnh viễn riêng của thiết bị** → *Thêm vào màn hình chính*
- Từ lần sau mở icon là vào thẳng, không cần mã nữa

Điểm cần biết về Quick Tunnel:
- **URL đổi mỗi lần bridge/cloudflared chạy lại** (mất điện, restart máy...) — bridge **tự in QR mới** trong terminal, quét lại 10 giây là xong.
- Không SLA (dùng cá nhân: giữ bridge chạy là ổn). Bridge cũng tự revive cloudflared nếu nó chết.
- Tắt tunnel: chạy bridge với `OPENWORK_BRIDGE_TUNNEL=0`.

**URL cố định vĩnh viễn — đã có sẵn, 0đ:** web chính thức chạy tại [`https://YOUR-WORKER.workers.dev`](https://YOUR-WORKER.workers.dev) (Cloudflare Worker `worker/` trong dự án). Bridge tự "báo địa chỉ" lên worker mỗi 15 phút (đổi tunnel là báo ngay), nên điện thoại chỉ cần nhớ đúng 1 URL này — tunnel đổi bao nhiêu cũng tự tìm lại. QR ghép thiết bị cũng tự trỏ về URL này. Hai lựa chọn dưới đây chỉ cần khi muốn thêm lớp riêng tư:

| Cách | Chi phí | Ghi chú |
|---|---|---|
| **Worker openpocket (mặc định)** | 0đ | URL cố định + multi-tenant (mục dưới); đã deploy sẵn |
| Cloudflare **Named Tunnel** + domain | ~200k/năm (tiền domain) | URL cố định; thêm được Cloudflare Access (OTP email) |
| **Tailscale** (`tailscale serve --bg 8788`) | 0đ | URL cố định `https://<pc>.<tailnet>.ts.net`, riêng tư nhất — nhưng điện thoại phải cài app Tailscale |

**Tự chạy bridge khi bật máy (khuyên dùng):**
```bash
openpocket autostart --enable --with-openwork   # đăng nhập Windows là bridge + OpenWork tự mở
openpocket autostart --status                   # xem đang bật hay tắt
openpocket autostart --disable                  # tắt tự chạy
```
Không kèm `--with-openwork` thì chỉ bridge tự chạy (OpenWork bạn tự mở tay — bridge tự dò lại server mỗi 5s nên thứ tự không quan trọng).

**Bật OpenWork từ điện thoại:** máy tính đang bật + bridge đang chạy mà app OpenWork chưa mở → mở app trên điện thoại sẽ thấy nút **"Bật OpenWork trên máy tính"** (ngay banner đỏ + trong Cài đặt → Trạng thái bridge). Bấm → đợi ~20s → bấm Kiểm tra lại. Lưu ý: máy tính tắt hẳn/ngủ sâu thì chịu — phải bật máy lên trước.

### Xem & điều khiển màn hình máy tính (tab "Màn hình")

Mở app → tab **Màn hình** (nav đáy) là thấy màn hình máy tính ngay, giống mở TV xem camera nhà:

- **Xem**: bridge chụp màn hình ~3-4 hình/s, nén JPEG và đẩy thẳng về điện thoại (RAM chỉ giữ đúng 1 khung — **không lưu vào đĩa gì cả**). Chọn chất lượng: Nhanh (tiết kiệm 3G) / Cân bằng / Nét. Màn đứng yên gần như tốn 0 byte.
- **Điều khiển**: bấm nút "Chỉ xem" để đổi thành "Đang điều khiển" → **chạm vào hình = click tại đó**, **giữ rồi kéo = kéo thả**, các nút phụ: chuột phải, double-click, cuộn, Enter/Esc/Backspace/Tab, tổ hợp (bật sáng Ctrl/Alt/Shift/Win rồi bấm phím), và **ô gõ chữ tiếng Việt** — chữ được đưa sang máy tính qua clipboard + dán, nên dấu nguyên vẹn dù máy cài Unikey.
- **Giới hạn đáng nhớ**: không thấy màn hình khóa / UAC (Windows chặn chụp secure desktop); chỉ monitor chính; không điều khiển được app chạy quyền As Admin; khoảng 3-4 hình/s là "chụp liên tục" chứ không phải video. Không ai xem thì bridge tự ngừng chụp sau 90 giây cho mát máy.
- Cơ chế học từ **9Remote** (mổ xẻ bản npm cài trên máy): chụp bằng `node-screenshots` + nén `sharp`, điều khiển bằng daemon C# tự compile (SendInput), gõ chữ đi clipboard — đúng bài bản của họ nhưng tự dựng lại toàn bộ, không dùng code của họ.

## Nhiều máy trên cùng một web (multi-tenant)

Web `YOUR-WORKER.workers.dev` là "tòa nhà nhiều phòng": ai cũng mở được, nhưng mỗi người chỉ đụng được OpenWork **máy nhà mình**. Chủ worker cấp cho mỗi người bạn một cặp **tên đăng nhập + mật khẩu** — dùng được cho cả 2 đầu:

| Đầu | Cách nhập |
|---|---|
| Máy PC của bạn ấy | `openpocket edge join https://YOUR-WORKER.workers.dev` → nhập user/pass (1 lần, lưu config) — bridge tự heartbeat lên "phòng" của họ |
| Điện thoại của bạn ấy | Mở web → tab **Đăng nhập** → nhập cùng cặp user/pass (1 lần — nhận khóa vĩnh viễn như pair thường, mật khẩu không lưu trên web) |

Lệnh phía chủ worker (chạy trong `worker/`, cần `wrangler` đã đăng nhập):

```bash
node scripts/tenant.mjs add nam "Máy của Nam"   # cấp phòng + in "thẻ mời" gửi bạn
node scripts/tenant.mjs list                    # xem các phòng đang có
node scripts/tenant.mjs revoke nam              # xóa phòng (máy đó hết chỗ báo địa chỉ)
```

Máy của chủ worker không phải đổi gì — không join phòng thì tiếp tục chạy luồng `machine:main` như cũ. Giới hạn đáng nhớ: bridge heartbeat mỗi 15 phút nên KV free (~1000 ghi/ngày) đủ cho **~10 phòng**; mỗi điện thoại ghép 1 máy (đổi máy = Cài đặt → Gỡ pairing → đăng nhập lại).

## Cấu trúc dự án

```
bridge/          # Node.js — discovery, token bootstrap, proxy, static, QR
  src/           # index.js (entry) · proxy.js · discovery.js · bootstrap.js · auth.js · screen.js + desktop-input.cs (màn hình) · fslist.js …
  test/          # unit test (npm test)
  scripts/       # e2e-live.mjs, dbg-prompt.mjs, dbg-screen.mjs (test live với OpenWork thật)
worker/          # Cloudflare Worker "openpocket" — URL cố định + multi-tenant
  src/index.js   # /__register (đăng ký phòng) · /api/* (relay theo phòng) · serve web
  scripts/tenant.mjs # cấp/xóa phòng (tài khoản user/pass) trên KV
web/             # PWA Preact + Vite → build ra web/dist do bridge serve
  src/pages/     # pairing (Đăng nhập/Ghép/Nhập token) · workspaces · sessions · chat · files · screen (màn hình) · settings
  src/components/# ui.jsx (Loading/Skeleton/Empty/Banner/Sheet/Confirm) · icons.jsx (SVG set)
  .zcode/skills/ # pwa-workspace-ui: skill thiết kế nội bộ (tokens · ui-rules · pwa-checklist)
README.md        # file này
CODE_SUMMARY.md  # bản đồ code + bảng "triệu chứng → chỗ sửa"
```

## Bảo mật (mô hình Pair Device học từ 9Remote)

- **Mã ghép một lần, sống 30 phút**: nằm trong QR/terminal của bridge — dùng đúng 1 lần rồi chết. QR bị lộ cũng chỉ nguy hiểm trong 30 phút.
- **Khóa thiết bị vĩnh viễn (`owd_...`)**: sau khi ghép, mỗi điện thoại nhận khóa riêng (lưu trong điện thoại, bridge chỉ lưu hash). Mở lại app bao giờ cũng vào thẳng.
- **Thu hồi từng thiết bị**: trong app → Cài đặt → *Thiết bị đã ghép*. Mất điện thoại? Bấm thu hồi là nó mất quyền truy cập ngay lập tức.
- **Phòng (multi-tenant)**: secret của mỗi phòng nằm trên worker KV và bridge của người đó; worker KHÔNG giữ khóa điện thoại của ai — mọi khóa vẫn do bridge tự kiểm tra. Web chỉ lưu khóa vĩnh viễn, không lưu mật khẩu. Đăng nhập sai tên hoặc sai mật khẩu trả **cùng một câu trả lời** — người lạ không dò ra được phòng nào tồn tại, càng không thấy máy của nhau. Xóa phòng (`tenant.mjs revoke`) là máy đó không tự báo địa chỉ được nữa.
- Token master `owm_...` chỉ là đường dự phòng in trên terminal (dùng tại máy, không đưa cho ai).
- Bridge chỉ nghe `127.0.0.1` — bên ngoài chỉ thấy qua tunnel/tailnet; mọi request phải có token hợp lệ (deny-by-default); `/api/pair` được rate-limit chống dò mã.
- Token owner `owt_...` của OpenWork không bao giờ gửi ra browser; proxy whitelist chỉ cho phép path quản trị (`bridge/src/proxy.js`).

## Xử lý sự cố nhanh

| Triệu chứng | Cách xử lý |
|---|---|
| Ghi/lỗi `"Sign in to verify policy"` | Mở OpenWork desktop đăng nhập/verify lại (phiên cloud hết hạn) |
| Prompt gửi xong không có reply | Chưa chọn model trong chat — model là bắt buộc |
| Không tìm thấy openwork-server | OpenWork desktop có đang chạy không? |
| Khác | Mở [CODE_SUMMARY.md](./CODE_SUMMARY.md) — bảng tra đầy đủ |

## Phát triển

```bash
cd bridge && npm test                                   # unit test
node bridge/scripts/e2e-live.mjs <wsId> <provider> <model>   # E2E live
cd web && npm run dev                                   # dev server (proxy /api qua bridge)
cd web && npm run build && cd ../worker && npx wrangler deploy # build + deploy worker "địa chỉ cố định" (openpocket)
cd web && npm run deploy                                # build + deploy worker phụ openwork-mobile-web (vite-plugin, URL dự phòng)
cd worker && node scripts/tenant.mjs add <user> "Tên"   # cấp phòng multi-tenant (list / revoke để quản)
```

## Quy tắc dự án

> 📌 **Mỗi khi thay đổi code/cấu trúc/hành vi, PHẢI cập nhật đồng thời `README.md` và `CODE_SUMMARY.md` trong cùng commit.** README = mặt ngoài (cách dùng, tính năng); CODE_SUMMARY = mặt trong (chỗ sửa, bản đồ API).
