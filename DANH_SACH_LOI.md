# DANH SÁCH LỖI KỸ THUẬT (OPENPOCKET) — CẬP NHẬT 2026-10-03

> **Dự án:** OpenWork Mobile (OpenPocket)
> **Hiện trạng nhánh:** `main` — commit `fe3830f` + các thay đổi đang chờ commit (review-fix pairing/worker/config, gỡ nốt `bridge/VERSION`, viết lại tài liệu).
>
> ⚠️ **Bản cũ của file này VÔ HIỆU 100% và đã bị thay thế toàn bộ:** mọi lỗi nó liệt kê (thiếu cờ `/unsafe` khi biên dịch `desktop-capture.cs`, cắt nhầm 8 byte header JPEG trong `screen.jsx`…) đều nằm ở các file **ĐÃ BỊ XOÁ KHỎI DỰ ÁN** kể từ commit `2a202a3` (gỡ tính năng xem/điều khiển máy tính từ xa: `web/src/pages/screen.jsx`, `web/src/pages/pcs.jsx`, `bridge/src/desktop-capture.cs`, `bridge/src/screen-dxgi.js`, `bridge/src/screen-capture.worker.js`, `bridge/src/webrtc.js`, `bridge/src/desktop-input.cs`, cùng các dependency native `sharp`, `node-screenshots`, `node-datachannel`). Những lỗi đó **không còn tồn tại trong code** — `grep -rniE "turnkey|turntoken|webrtc|dxgi|screen" bridge/src/ worker/src/index.js` trả về rỗng (đã chạy 03/10/2026, chỉ còn 1 comment lịch sử về file VERSION tại `bridge/src/index.js:21`).

---

## 1. LỖI ĐÃ PHÁT HIỆN — ĐÃ SỬA (trong lượt này, 2026-10-03)

### Nhóm bridge — vá 10 lỗi độ bền (commit `1d96865` + test kèm theo)

| # | Lỗi | Chỗ sửa | Bằng chứng |
|---|---|---|---|
| 1 | Retry khi port 8788 bị chiếm đếm lại từ đầu ở mỗi vòng callback → retry vô hạn | `bridge/src/index.js` — bộ đếm chung sống sót qua callback, trần 10 lần × 400ms | `bridge/test/listener.test.js` |
| 2 | stdout nền in mã pairing / QR / master token (rò rỉ khoá qua log) | `printPairing` yêu cầu TTY; bỏ banner token vô điều kiện | `bridge/test/startup.test.js` boot process thật, assert stdout không chứa khoá |
| 3 | Worker fan-out mã/khóa roomless cho MỌI máy còn sống (probe chéo máy người khác) | `worker/src/index.js` — 400 `tenant_required`, thông điệp viết lại 03/10 (không còn trỏ tới UI đăng nhập đã xoá) | `worker/test/relay.test.mjs` (KV/fetch mock) |
| 4 | Đường asset-first của Cloudflare đi vòng qua CSP bọc bởi Worker | `web/public/_headers` — CSP giống hệt, Vite copy vào `web/dist` | build OK; header production vẫn cần kiểm chứng ngoài deploy (mục 2) |
| 5–10 | Các vá độ bền còn lại của lượt `1d96865` (log retention, hợp đồng lỗi relay, auth tĩnh…) | chi tiết theo bảng "Reliability maintenance" trong `CODE_SUMMARY.md` | 9 file test bridge, 36 test |

### Nhóm web API — dọn export chết + test thật lần đầu (commit `efe2a5f` + working tree)

| # | Lỗi | Chỗ sửa | Bằng chứng |
|---|---|---|---|
| 11 | 7 export chết trong `web/src/api.js` sau khi xoá tính năng (`listKeys`, `renameKey`, `ensureActiveKeyEntry`, `inviteFromHash`, `apiPairTenant`, `apiMachineStatus`, `apiRevokeMachineKey`) | Xoá (grep xác nhận 0 nơi import); `fileToBase64`/`MAX_UPLOAD_BYTES` chuyển thành nội bộ module | `web/test/api-keyring.test.js` |
| 12 | `npm --prefix web test` xanh với **0 test** (chưa từng có test thật) | 2 suite thật shim localStorage/location/fetch, env trỏ thư mục tạm: keyring 10 test + hợp đồng lỗi 15 test (`ow()` 401 → UNPAIRED, `error.code` cho `tenant_required`, `sseUrl()`, `filenameFromDisposition()`) | `cmd /c npm --prefix web test` → **25 pass / 0 fail** (03/10) |
| 13 | IIFE migrate keyring chạy lúc import → không test được trong Node trần | Chuyển thành `migrateKeys()` export, idempotent, gọi lười ở lần `loadKeys()` đầu | test "importing api.js touches no storage" |

### Nhóm web UI — state-lie + dọn chết (commit `fe3830f`)

| # | Lỗi | Chỗ sửa |
|---|---|---|
| 14 | `settings.jsx` `recheck()` có `try/finally` không `catch` — tunnel chết/401 nuốt im lặng | Hiện "Kiểm tra lỗi: …" trong dòng `role="alert"` |
| 15 | Banner app báo sai "Không tìm thấy openwork-server" cho mọi lỗi mạng | `StatusBanners` đọc `state.error` TRƯỚC, in lỗi thật |
| 16 | `FileViewer` cleanup closure bắt state cũ → blob URL tải xong KHÔNG bao giờ bị revoke (rò rỉ, iOS Safari giết tab) | Mirror qua `dlRef`; tải mới revoke URL cũ trước |
| 17 | `FilesPage.load()` không abort/không thứ tự — response chậm hơn đè thư mục cũ lên breadcrumb mới | Bộ đếm `seq` + `AbortController` |
| 18 | Hàng đợi chat gửi prompt với model CŨ khi đổi model rồi mất mạng; queue invisible | `modelBody()` đọc `modelRef`; dòng `.chat-status` (1 `aria-live` duy nhất, thay vì `aria-live` bọc cả transcript) |
| 19 | PWA cài sẵn vẫn phục vụ shell cũ chứa tab đã xoá (precache v47) | Bump `CACHE = "owm-shell-v48"` |
| 20 | ~475 dòng CSS chết + 9 icon chết sau khi xoá trang viewer | Xoá sạch (grep 0 tham chiếu JSX); CSS 27.61→19.90 kB |

### Nhóm GUI desktop (commit `e5e4571`, chỉ `desktop/src/OpenPocket.cs`)

| # | Lỗi | Chỗ sửa |
|---|---|---|
| 21 | Thoát tray khi callback nền đang bay → crash ObjectDisposedException (6 chỗ `this.Invoke` không guard) | `MainForm.SafeInvoke`: kiểm tra `IsDisposed`/`IsHandleCreated` TRƯỚC khi marshal, nuốt race dispose |
| 22 | 3 chỗ `WaitForExit()` không timeout chạy `schtasks` trên UI thread → treo cửa sổ | `WaitForExit(10000)`; đọc `ExitCode` sau cờ `exited` |
| 23 | WMI fallback kill MỌI `node.exe` nào có chữ "bridge" + "index.js" trong cmdline → giết nhầm bridge người khác | Match bắt buộc full path `bridgeDir\src\index.js`; không resolve được `bridgeDir` thì bỏ qua hẳn |
| 24 | "Bật Bridge" bỏ qua exit code của `schtasks /run` VÀ tự tạo lại task autostart người dùng vừa bỏ tick | `using (Process)` + MessageBox lỗi; task CHỈ được tạo bởi checkbox; không có task thì `StartBridgeDirect()` chạy node trực tiếp |
| 25 | Poll 3,5s làm máy yếu giật (probe 500ms + đọc nguyên 2 file log mỗi tick) | Probe 150ms; chỉ đọc 32KB cuối mỗi log |
| 26 | Lỗi provision định danh máy bị nuốt im lặng — bạn bè thấy đèn xanh nhưng máy không hiện trên phone | `provisionError` + dòng trạng thái "Định danh máy" (vàng/đỏ + nút thử lại) |
| 27 | Khối `npm install` lúc chạy (chờ tới 5 phút) đã lỗi thời sau khi bộ cài vendor node_modules | Xoá `EnsureBridgeInstalledAsync`/`bridgeNeedsInstall`; thay bằng `EnsureBridgeDepsPresent()` — 1 MessageBox chính xác cho từng thứ thiếu |

### Nhóm bộ cài (commit `616238c`)

| # | Lỗi | Chỗ sửa |
|---|---|---|
| 28 | Máy bạn bè phải tự `npm install` bridge khi cài | `desktop/build-setup.js` vendor closure production từ `bridge/package-lock.json` (đúng 1 gói `qrcode-terminal@0.12.0`) vào installer |
| 29 | Thiếu Node.js → chặn cài hẳn + mở nodejs.org + exit 1 | Hạ cấp thành cảnh báo Yes/No không chặn (node.exe vẫn cần để CHẠY bridge) |
| 30 | Đóng gói dist web CŨ im lặng | Assert `web/dist` mới hơn mọi nguồn `web/src`… không thì abort "rebuild first"; `--stage-only` để kiểm chứng |

### Gỡ OTA + review-fix (commit `3df494d` + working tree)

| # | Việc | Chi tiết |
|---|---|---|
| 31 | **Gỡ kênh OTA** — updater, watchdog rollback, publisher, KV release routes trên worker, file `bridge/VERSION` (bản working tree xoá nốt; `desktop/build-setup.js` không còn copy VERSION). **Cách phát hành DUY NHẤT còn lại = bộ cài `OpenPocket-Setup.exe`** | `bridge/package.json` là nguồn version duy nhất (`bridge/src/index.js:21`) |
| 32 | `pairing.jsx` + `api.js` — hàng khóa trần: worker thực tế từ chối roomless, màn hình phải tự nhận diện `tenant_required` qua `error.code` và có thêm **ô Phòng** để gõ tên phòng cho khóa trần | 3 test hợp đồng mới |
| 33 | `config.js`/`index.js` — QR in trúng địa chỉ worker ngay cả khi KHÔNG có phòng (worker từ chối 400) | `pairingBaseUrl()` thuần + unit test: chỉ khi CÓ `lookupTenant` worker mới thắng, không thì tunnel → publicUrl → localhost |
| 34 | **Tài liệu sai hoàn toàn** (README, CODE_SUMMARY, DANH_SACH_LOI, THAM_DINH_DU_AN) — còn quảng cáo tính năng đã xoá, deps cũ, OTA đã gỡ, số test sai | Viết lại toàn bộ theo hiện trạng (lượt này, chỉ đụng .md + .gitignore) |

---

## 2. LỖI / VIỆC CÒN MỞ (openIssues — CHƯA sửa)

| # | Vấn đề | Vị trí | Lý do còn mở |
|---|---|---|---|
| O1 | `FindNodeExe()` còn đúng 1 chỗ `p.WaitForExit()` không timeout trên `where.exe` | `desktop/src/OpenPocket.cs` | Nằm ngoài 3 điểm đã nêu tên của lượt hardening; thực tế chạy nhanh, không quan sát được treo |
| O2 | Comment route `app.jsx` vẫn chép "settings gồm mục Máy của tôi — chùm chìa nhiều máy" trong khi UI đã bỏ từ 13/09 | `web/src/app.jsx:20` | Là comment code, ngoài phạm vi file `.md` của lượt tài liệu |
| ~~O3~~ | ~~CSP production chưa verify trên môi trường thật~~ | `web/public/_headers` | **ĐÃ ĐÓNG 04/10**: deploy thật (`openpocket`, version `e2bd9e28`), header CSP xuất hiện đúng trên `https://YOUR-WORKER.workers.dev/` và app khởi động được dưới CSP đó (`script-src 'self'` không chặn bundle). Ghi lại ở đây để lượt sau khỏi tìm lại |
| O4 | Chống xung đột file khi ghi trùng chưa có; **hàng đợi offline thì đã có** | `web/src/pages/files.jsx` | Lượt audit 04/10 đã tách hàng đợi theo phiên (`sessionId -> tin`) + `queueRestore` và khoá lần gửi lại; còn lại phần ghi file trùng nội dung |
| O5 | Bề mặt API dormant: `POST /api/pair/tenant` (bridge) và `POST /api/tenant/create` (worker) còn sống nhưng không UI nào gọi (trừ self-provision của GUI); KV free tier chỉ đủ ~10 phòng (~1000 ghi/ngày) | `bridge/src/index.js`, `worker/src/index.js` | Chủ động giữ lại — phí 0, route đã có test; giới hạn KV là đặc tính free tier |
| O6 | Lịch sử quét mật khẩu phòng mặc định `12345678`: các phòng tạo TRƯỚC 13/09 vẫn cần re-key (revoke + add) thủ công | KV worker | Việc vận hành trên KV thật, không phải lỗi code |

---

## 3. KIỂM CHỨNG ĐÃ CHẠY (03/10/2026, `OPENWORK_BRIDGE_DIR`/`OPENWORK_DIR` trỏ thư mục tạm `%TEMP%\owm-doc-*`)

| Lệnh | Kết quả |
|---|---|
| `cmd /c npm --prefix bridge test` | **36 pass / 0 fail** |
| `cmd /c npm --prefix web test` | **25 pass / 0 fail** |
| `node --test worker/test/*.test.mjs` | **11 pass / 0 fail** |
| `npm --prefix web run build` | OK (JS 78.846 B → 26.633 B gzip; CSS 19.901 B → 4.620 B gzip) |
| `grep -rniE "turnkey|turntoken|webrtc|dxgi|screen" bridge/src/ worker/src/index.js` | Rỗng (chỉ 1 comment lịch sử về VERSION tại `bridge/src/index.js:21`) |
