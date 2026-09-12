# OpenWork Mobile

Web app (PWA) quản lý **sessions, workspaces và files** của [OpenWork](https://github.com/different-ai/openwork) desktop từ điện thoại — không cần APK, iOS & Android đều dùng được, tự kết nối mỗi khi mở trang.

```
Điện thoại (PWA, bất kỳ đâu có mạng)
   │  HTTPS qua tailscale serve
   ▼
openwork-bridge  (máy tính, 127.0.0.1:8788)
   │  Bearer token owner (tự mint)
   ▼
openwork-server  (có sẵn trong OpenWork desktop, port động)
   ▼
opencode engine  →  sessions / models / files
```

Gặp lỗi → mở **[CODE_SUMMARY.md](./CODE_SUMMARY.md)** — bảng "triệu chứng → chỗ sửa".

## Tính năng (v1)

- Danh sách workspaces & sessions (cập nhật live qua SSE)
- Xem transcript, gửi prompt (chọn model), abort session
- Trả lời permission request từ xa (Allow/Deny)
- File manager: duyệt cây thư mục, xem/sửa + lưu file text, xem ảnh, upload từ điện thoại, tải file về
- Tạo session mới / tạo workspace mới
- Offline queue (tin nhắn soạn khi mất mạng tự gửi khi nối lại), PWA cài màn hình chính

## Cài đặt (máy tính — làm 1 lần)

```bash
# 1. Bridge
cd bridge
npm install

# 2. Web app
cd ../web
npm install
npm run build

# 3. Chạy bridge
cd ../bridge
npm start
```

Lần đầu chạy, bridge tự:
1. Mint token owner vào `%APPDATA%\openwork\tokens.json`
2. In ra màn hình **QR + URL pairing + mã `owm_...`**

> ⚠️ **Restart OpenWork desktop đúng 1 lần** sau lần chạy bridge đầu tiên để token có hiệu lực (OpenWork chỉ nạp tokens.json lúc khởi động). Bridge tự nhận biết — không cần làm gì thêm.

## Dùng trên điện thoại (Tailscale — miễn phí)

1. Cài [Tailscale](https://tailscale.com) trên **máy tính** và **điện thoại**, đăng nhập cùng tài khoản (gói Personal miễn phí).
2. Trên máy tính chạy 1 lệnh:
   ```
   tailscale serve --bg 8788
   ```
   → được URL dạng `https://<tên-máy>.<tailnet>.ts.net` (HTTPS cert thật).
3. Mở `npm start` của bridge — terminal in URL pairing kèm QR cho URL tailscale:
   ```
   set OPENWORK_PUBLIC_URL=https://<tên-máy>.<tailnet>.ts.net   (Windows: setx)
   ```
4. Quét QR trên điện thoại → tự pair → "Thêm vào màn hình chính" để dùng như app.

Trong nhà/cùng WiFi cũng đi qua tailscale (đơn giản hóa — đã bỏ chế độ LAN riêng theo yêu cầu).

## Chạy bridge tự động khi bật máy (tùy chọn)

Task Scheduler → Create Task:
- Trigger: At log on
- Action: `node "C:\Antigravity\Openwork Mobile App\bridge\src\index.js"`

## Bảo mật

- Bridge chỉ nghe `127.0.0.1` — bên ngoài chỉ thấy qua tailnet của bạn (không lộ internet).
- Điện thoại pair bằng token `owm_...` riêng (revoke: xóa field `mobileToken` trong `%APPDATA%\openwork-bridge\config.json` rồi chạy lại bridge).
- Token owner `owt_...` của OpenWork không bao giờ gửi ra browser — bridge tự inject.
- Proxy whitelist: chỉ các path quản trị được chuyển tiếp (xem `bridge/src/proxy.js`).

## Lưu ý quan trọng

- **OpenWork phải đang chạy** trên máy tính (engine tắt = không chat được; file manager vẫn hoạt động).
- Nếu mọi thao tác ghi trả lỗi `"Sign in to verify your organization's policy"` → mở OpenWork desktop và đăng nhập/verify lại (hết hạn phiên cloud). Bridge và web sẽ tự hoạt động lại.
- Gửi prompt **phải kèm model** (`{providerID, modelID}`) — web app tự xử lý qua model picker; nếu dùng API trực tiếp thì nhớ truyền.
- OpenWork update có thể đổi format dữ liệu → sửa 2 adapter (`discovery.js`, `bootstrap.js`), xem CODE_SUMMARY.md.
