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

- 📁 **Workspaces**: danh sách live, tạo workspace mới (FAB gradient)
- 💬 **Sessions**: danh sách (busy/idle realtime), tạo mới, xem transcript đầy đủ (text/tool/reasoning, markdown + code block), gửi prompt (chọn model), abort
- 🔐 **Permissions**: duyệt Allow/Deny ngay trên điện thoại khi agent xin phép
- 🗂 **Files**: duyệt cây thư mục, xem/sửa + lưu file text, xem ảnh, upload từ điện thoại, tải file về
- 📴 **Offline queue** + auto-reconnect; PWA cài màn hình chính iOS/Android

## Giao diện (v3 "OpenWork brand")

Bám đúng bảng màu của **OpenWork desktop chính chủ** (soi từ
`resources/app-dist/assets/index-*.css` — Radix Colors): nền slate dark
`#111113`, card `#18191b`, accent **xanh dương đặc `#0090ff`** (không gradient),
radius nhỏ nét. Mobile-first theo skill nội bộ `pwa-workspace-ui`
(`.zcode/skills/`, tổng hợp từ mobile-hybrid-audit + pwa-review + Vercel
web-interface-guidelines + Anthropic frontend-design): bottom nav nổi pill blur,
FAB xanh, card có icon tile, chấm trạng thái session, empty-state có icon + nút
hành động, icon SVG toàn bộ (không emoji), input 16px chống iOS zoom, nút ≥44px,
safe-area (notch/home indicator), skeleton loading, `prefers-reduced-motion`.

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

**Muốn URL cố định vĩnh viễn + không cần quét lại QR** — 2 lựa chọn nâng cấp:
| Cách | Chi phí | Ghi chú |
|---|---|---|
| Cloudflare **Named Tunnel** + domain | ~200k/năm (tiền domain) | URL cố định; thêm được Cloudflare Access (OTP email) — bảo mật đẹp nhất khi lộ công khai |
| **Tailscale** (`tailscale serve --bg 8788`) | 0đ | URL cố định `https://<pc>.<tailnet>.ts.net`, riêng tư nhất — nhưng điện thoại phải cài app Tailscale |

**Chạy bridge tự động khi bật máy (tùy chọn):** Task Scheduler → Action: `node "C:\Antigravity\Openwork Mobile App\bridge\src\index.js"`, Trigger: At log on.

## Cấu trúc dự án

```
bridge/          # Node.js — discovery, token bootstrap, proxy, static, QR
  src/           # index.js (entry) · proxy.js · discovery.js · bootstrap.js · auth.js …
  test/          # unit test (npm test)
  scripts/       # e2e-live.mjs, dbg-prompt.mjs (test live với OpenWork thật)
web/             # PWA Preact + Vite → build ra web/dist do bridge serve
  src/pages/     # pairing · workspaces · sessions · chat · files · settings
  src/components/# ui.jsx (Loading/Skeleton/Empty/Banner/Sheet/Confirm) · icons.jsx (SVG set)
  .zcode/skills/ # pwa-workspace-ui: skill thiết kế nội bộ (tokens · ui-rules · pwa-checklist)
README.md        # file này
CODE_SUMMARY.md  # bản đồ code + bảng "triệu chứng → chỗ sửa"
```

## Bảo mật (mô hình Pair Device học từ 9Remote)

- **Mã ghép một lần, sống 30 phút**: nằm trong QR/terminal của bridge — dùng đúng 1 lần rồi chết. QR bị lộ cũng chỉ nguy hiểm trong 30 phút.
- **Khóa thiết bị vĩnh viễn (`owd_...`)**: sau khi ghép, mỗi điện thoại nhận khóa riêng (lưu trong điện thoại, bridge chỉ lưu hash). Mở lại app bao giờ cũng vào thẳng.
- **Thu hồi từng thiết bị**: trong app → Cài đặt → *Thiết bị đã ghép*. Mất điện thoại? Bấm thu hồi là nó mất quyền truy cập ngay lập tức.
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
```

## Quy tắc dự án

> 📌 **Mỗi khi thay đổi code/cấu trúc/hành vi, PHẢI cập nhật đồng thời `README.md` và `CODE_SUMMARY.md` trong cùng commit.** README = mặt ngoài (cách dùng, tính năng); CODE_SUMMARY = mặt trong (chỗ sửa, bản đồ API).
