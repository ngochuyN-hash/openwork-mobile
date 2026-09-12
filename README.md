# OpenWork Mobile

Quản lý **sessions, workspaces và files** của [OpenWork](https://github.com/different-ai/openwork) desktop **từ điện thoại, ở bất kỳ đâu** — web app (PWA) tự kết nối mỗi khi mở trang, không cần APK, chạy được cả iOS lẫn Android, chi phí **0 đồng**.

## Giới thiệu dự án

OpenWork là app desktop (Electron, opensource) để chạy các AI coding agent — nhưng chỉ dùng được tại máy tính. Dự án này thêm một "cửa sau" chính chủ cho điện thoại:

| Yêu cầu ban đầu | Cách đáp ứng |
|---|---|
| Quản lý session & workspace đang có | Bridge nối thẳng vào API có sẵn của openwork-server chạy trong OpenWork desktop |
| Quản lý file khi ra ngoài | File manager: duyệt / xem / **sửa + lưu** / upload / tải về |
| Chạy nhẹ | Bridge = 1 tiến trình Node, ~0 dependency; web app ~38KB (gzip 14KB); không DB riêng |
| Tương tác từ xa, giữ kết nối | SSE streaming + auto-reconnect + offline queue (tin nhắn soạn offline tự gửi khi có mạng) |
| Không APK, iOS dùng được | Web/PWA — mở link là tự kết nối, "Thêm vào màn hình chính" như app thật |
| Miễn phí hoàn toàn | Tailscale gói Personal (3 user / 100 thiết bị) + model free của OpenCode Zen |

**Nguyên tắc thiết kế:** không viết lại những gì OpenWork đã có. Bridge chỉ là lớp mỏng: tìm server → giữ token → chuyển tiếp có chọn lọc + serve web. OpenWork update thì mình chỉ sửa 2 adapter (đã ghi rõ trong [CODE_SUMMARY.md](./CODE_SUMMARY.md)).

```
Điện thoại (PWA, 4G/5G bất kỳ đâu)
   │  HTTPS (cert thật) qua tailscale serve
   ▼
openwork-bridge  (máy tính, Node.js, 127.0.0.1:8788)
   │  Bearer token owner (bridge tự mint, không lộ ra điện thoại)
   ▼
openwork-server  (API có sẵn trong OpenWork desktop, port động)
   ▼
opencode engine  →  sessions · models · files
```

## Tính năng (v1)

- 📁 **Workspaces**: danh sách live, tạo workspace mới
- 💬 **Sessions**: danh sách (busy/idle realtime), tạo mới, xem transcript đầy đủ (text/tool/reasoning), gửi prompt (chọn model), abort
- 🔐 **Permissions**: duyệt Allow/Deny ngay trên điện thoại khi agent xin phép
- 🗂 **Files**: duyệt cây thư mục, xem/sửa + lưu file text, xem ảnh, upload từ điện thoại, tải file về
- 📴 **Offline queue** + auto-reconnect; PWA cài màn hình chính iOS/Android

## Yêu cầu

- Máy tính Windows đang chạy **OpenWork desktop** + **Node.js ≥ 20**
- Điện thoại cài **Tailscale** (miễn phí) — dùng từ xa; trong nhà cũng đi qua đường này cho đơn giản

## Cài đặt (máy tính — làm 1 lần)

```bash
# 1. Bridge
cd bridge && npm install

# 2. Web app
cd ../web && npm install && npm run build

# 3. Chạy bridge
cd ../bridge && npm start
```

Lần đầu chạy, bridge tự mint token vào OpenWork và in ra **QR + mã pairing `owm_...`**.

> ⚠️ Sau lần chạy bridge **đầu tiên**, restart OpenWork desktop **đúng 1 lần** để token có hiệu lực (OpenWork chỉ nạp `tokens.json` lúc khởi động). Bridge tự nhận biết — làm 1 lần thôi.

## Dùng trên điện thoại

1. Cài Tailscale trên **máy tính + điện thoại**, đăng nhập cùng tài khoản (miễn phí).
2. Trên máy tính: `tailscale serve --bg 8788` → có URL `https://<tên-máy>.<tailnet>.ts.net`.
3. Muốn QR in đúng URL tailscale: `setx OPENWORK_PUBLIC_URL https://<tên-máy>.<tailnet>.ts.net` rồi chạy lại bridge.
4. Mở link/QR trên điện thoại → tự pair → *Thêm vào màn hình chính*.

**Chạy bridge tự động khi bật máy (tùy chọn):** Task Scheduler → Action: `node "C:\Antigravity\Openwork Mobile App\bridge\src\index.js"`, Trigger: At log on.

## Cấu trúc dự án

```
bridge/          # Node.js — discovery, token bootstrap, proxy, static, QR
  src/           # index.js (entry) · proxy.js · discovery.js · bootstrap.js · auth.js …
  test/          # unit test (npm test)
  scripts/       # e2e-live.mjs, dbg-prompt.mjs (test live với OpenWork thật)
web/             # PWA Preact + Vite → build ra web/dist do bridge serve
  src/pages/     # pairing · workspaces · sessions · chat · files · settings
README.md        # file này
CODE_SUMMARY.md  # bản đồ code + bảng "triệu chứng → chỗ sửa"
```

## Bảo mật

- Bridge chỉ nghe `127.0.0.1` — bên ngoài chỉ thấy qua tailnet của bạn, không lộ internet công cộng.
- Điện thoại pair bằng token `owm_...` riêng (revoke: xóa `mobileToken` trong `%APPDATA%\openwork-bridge\config.json`, chạy lại bridge).
- Token owner `owt_...` của OpenWork không bao giờ gửi ra browser.
- Proxy whitelist: chỉ path quản trị được chuyển tiếp (`bridge/src/proxy.js`).

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
