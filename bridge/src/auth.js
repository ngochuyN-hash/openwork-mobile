import { timingSafeEqual } from "node:crypto";

// Auth for the bridge's own API. The phone presents the mobile token
// (owm_...) that lives in the bridge config; we never expose the OpenWork
// owner token to the browser.

export function isAuthorized(req, mobileToken) {
  const header = req.headers["authorization"] ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header));
  const presented = match?.[1]?.trim();
  if (!presented || !mobileToken) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(mobileToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

// 401 dùng chung cho cả "thiếu/sai token" và "đụng trần rate limit", nên message
// phải đúng cho cả hai: điện thoại đọc thấy cũng hiểu, và không rò đường dẫn.
export function deny(res) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: "unauthorized", message: "Unauthorized — missing or wrong connection key." }));
}

/** So sánh token đã trích (từ header Bearer) với master token. */
export function isTokenAuthorized(presented, mobileToken) {
  if (!presented || !mobileToken) return false;
  return sameToken(presented, mobileToken);
}

function sameToken(presented, expected) {
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Lấy token từ header `Authorization: Bearer …` — ĐƯỜNG DUY NHẤT còn sống.
 *
 * Trước đây còn một nhánh thứ hai đọc `?_t=` trên query (chỉ GET), sinh ra từ
 * lúc web dán token lên URL cho `<img>`/`<iframe>`/EventSource vì các thẻ đó
 * không set được header. Đường đó ĐÃ BỎ HẲN và không quay lại, vì token nằm
 * trong query sẽ rò ra ít nhất bốn chỗ mà header không bao giờ rò:
 *   - history/URL bar của trình duyệt (ai cũng mở xem lại được),
 *   - access log của Cloudflare và reverse proxy trước mặt bridge,
 *   - header Referer cho mọi request đi tiếp từ trang đó,
 *   - link bị copy-chia qua chat/nhắn tin, crash report, screenshot.
 * Chi phí bỏ: PWA đã cài trên máy cũ còn cache bundle cũ vẫn gửi `?_t=` sẽ
 * mất quyền, phải cài lại/mở lại web là xong. Đổi lại bridge không còn đường
 * nào để lộ master token ra ngoài header.
 *
 * `url` vẫn nằm trong chữ ký cho khớp call site (app.js) nhưng KHÔNG được đọc:
 * token không bao giờ đi URL nữa. Thêm nhánh query mới ở đây là đúng cách
 * mở lại đúng lỗi bảo mật đã đóng.
 */
export function requestToken(req, url) {
  void url; // chữ ký giữ nguyên cho call site; token chỉ đọc từ header.
  const header = req.headers["authorization"] ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header));
  return match?.[1]?.trim() ?? "";
}
