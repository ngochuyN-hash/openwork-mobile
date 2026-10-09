// BỘ ÁO GIÁP WEB DÙNG CHUNG — MỘT nguồn chân lý cho chính sách bảo mật gắn ở
// CẢ BA cửa vào của web (hợp đồng API cùng dòng họ nằm ở shared/contract.js):
//   1. worker: mọi response tĩnh đi qua withSecurityHeaders (worker/src/index.js)
//   2. bridge: static.js gắn securityHeaders() khi tự phục vụ web/dist qua tunnel
//   3. Cloudflare Assets: đọc file `web/dist/_headers` — file đó SINH RA lúc
//      build từ `renderHeadersFile()` ở đây (web/scripts/gen-headers.mjs chạy
//      sau `vite build`; KHÔNG sửa tay file sinh ra).
//
// Vì sao cần: trước 09/10 chính sách được chép tay 3 nơi và chỉ giữ giống nhau
// bằng comment "PHẢI giữ nguyên văn 3 bản" — lệch một chữ ở một cửa là cửa đó
// yếu hơn mà không ai biết (web có 2 cửa vào, thiếu header ở cửa nào thì tấm
// khiên "lọt XSS cũng không chạy được" chỉ còn ở cửa kia). Sửa chính sách =
// sửa FILE NÀY một chỗ rồi rebuild.
//
// File này PHẢI thuần: không import gì, không đụng Node/browser API — cả ba
// môi trường nạp được nguyên văn.

// CSP gắn lên mọi tài nguyên tĩnh — script thì tuyệt đối same-origin (không
// inline), nên nếu một ngày nào đó lọt XSS thì code chèn động cũng bị trình
// duyệt cấm chạy trước khi với tới token trong localStorage. blob: cho img vì
// khung hình stream + preview file là object URL; 'unsafe-inline' chỉ cho
// style — UI xài style attribute dày đặc. Thêm script CDN/iframe vào web thì
// phải nới ở đây.
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

export const CSP = CSP_DIRECTIVES.join("; ");

/**
 * Đầy đủ bộ header bảo mật cho 1 response app shell (dạng object thường).
 * - nosniff: cấm trình duyệt tự đoán kiểu nội dung — chặn kiểu tấn công "file
 *   tĩnh thật ra là HTML/JS", tức làm script chạy được dù CSP có chặt.
 * - no-referrer: app không cần referrer ở đâu cả (link ngoài đã rel=noreferrer,
 *   link nội bộ là hash-route cùng origin), nên không lộ đường dẫn/token cho
 *   bên thứ ba.
 */
export function securityHeaders() {
  return {
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

/**
 * Nội dung file `_headers` cho Cloudflare Assets (định dạng Pages: khối đường
 * dẫn `/*` rồi các dòng "Header: value" thụt lề). Sinh lúc build — sửa chính
 * sách ở CSP_DIRECTIVES phía trên, không sửa tay file dist. Tên header ghi
 * Title-Case như bản tay cũ (CF so tên không phân biệt hoa thường, nhưng giữ
 * nguyên văn cho diff sạch).
 */
export function renderHeadersFile() {
  const headers = securityHeaders();
  const titleCase = {
    "content-security-policy": "Content-Security-Policy",
    "x-content-type-options": "X-Content-Type-Options",
    "referrer-policy": "Referrer-Policy",
  };
  const lines = Object.entries(headers).map(([name, value]) => `  ${titleCase[name] ?? name}: ${value}`);
  return `/*\n${lines.join("\n")}\n`;
}
