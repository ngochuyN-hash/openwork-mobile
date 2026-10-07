// HỢP ĐỒNG API DÙNG CHUNG — MỘT nguồn chân lý cho những gì các tầng PHẢI cùng
// biết, dù chúng chạy ở 3 môi trường khác nhau:
//   - bridge: Node ESM thuần (`import "../../shared/contract.js"`),
//   - web: browser, bundle qua Vite (rollup theo relative import ra ngoài root),
//   - worker: Cloudflare Worker, bundle qua esbuild (import từ 07/10 —
//     worker/src/index.js; web/test/contract-fixture.test.js vẫn khoá literal
//     của worker như một lớp kiểm thứ hai).
//
// Vì sao cần: trước 06/10 các khoá hash `#p=`/`#t=`/`&m=`, header
// `x-owm-tenant`/`x-owm-secret`/`x-owm-invite`, mã lỗi `tenant_required`/
// `not_joined`/`tunnel_down`… và bộ tiền tố chìa `owm_/owd_/owt_` đều được chép
// tay ở từng tầng. Đổi một tên ở một tầng là tầng kia lặng lẽ chết — không có
// test nào bắt vì mỗi tầng test riêng. Sửa hợp đồng = sửa FILE NÀY một chỗ.
//
// File này PHẢI thuần: không import gì, không đụng Node/browser API — cả ba
// môi trường nạp được nguyên văn.

// --- Khoá trong link ghép nối (sau `#` của URL) ------------------------------
// `.../#p=<mã-one-time>&m=<phòng>` — mã 30 phút in trong QR terminal.
export const PAIR_CODE_HASH = "p";
// `.../#t=<chìa-vĩnh-viễn>&m=<phòng>` — master token, KHÔNG BAO GIỜ log nguyên.
export const MASTER_TOKEN_HASH = "t";
// Phòng gắn vào link để web tự điền (cả hai dạng link trên đều dùng `&m=`).
export const TENANT_HASH_KEY = "m";
// Phòng trong QUERY string (`?_m=`) — đường dự phòng cho SSE/fetch khi không
// đặt được header (worker đọc ở worker/src/index.js).
export const TENANT_QUERY_KEY = "_m";

// --- Header HTTP -------------------------------------------------------------
// Chọn "phòng" (máy) — web gửi lên worker; worker dùng để relay tới đúng bridge.
export const HEADER_TENANT = "x-owm-tenant";
// Chìa máy↔worker (BRIDGE_SECRET) — bridge `lookup.js` gửi, worker đối chiếu.
export const HEADER_BRIDGE_SECRET = "x-owm-secret";
// Mã mời nhúng trong exe chủ worker — cửa /api/tenant/create chỉ mở cho build
// của chủ worker (bridge không gửi; OpenPocket.exe gửi từ src/InviteKey.cs).
export const HEADER_INVITE = "x-owm-invite";

// --- Cửa đăng ký tunnel bridge→worker ----------------------------------------
// Đường RIÊNG của bridge (không qua /api/*, không relay): bridge báo "máy tôi
// đang ở địa chỉ này" — worker ghi slot KV rồi relay mọi /api/* tới đó.
// Auth bằng HEADER_BRIDGE_SECRET. Payload từ bridge/src/lookup.js:
//   {url}                       — đăng ký/heartbeat URL tunnel (có phòng: +tenant)
//   {url:"", tunnelDown:true, retryAt} — "máy sống, hầm đang chờ Cloudflare mở lại"
// Worker trả {ok:true}; LỖI trả envelope {error} — KHÁC với {code, message} của
// /api/*, là envelope cũ của cửa này, giữ nguyên (bridge chỉ nhìn response.ok):
// invalid_tenant/unauthorized (401) · invalid_url (400) · kv_write_failed (503).
// Mã đó là nội bộ cửa nên để literal tại worker; cái XUYÊN tầng ở đây chỉ là
// đường + header + shape payload.
export const REGISTER_PATH = "/__register";

// --- Tên phòng chuẩn hoá ------------------------------------------------------
// Worker so tên phòng làm KV key, bridge đăng ký (lookup.js), web điền từ link
// — cả ba phải ra CÙNG một chuỗi thì kẻ này mới tìm thấy máy của kẻ kia.
export function normalizeTenant(value) {
  return String(value ?? "").trim().toLowerCase();
}

// --- Mã lỗi máy-đọc (trường `code` trong JSON trả về) ------------------------
// Chỉ những mã XUYÊN tầng (tầng A phát, tầng B so/hiện) mới nằm ở đây; mã nội
// bộ của một tầng cứ để literal tại chỗ.
export const ErrorCode = {
  // worker phát khi link/chìa không mang phòng — pairing.jsx so để hiện hint.
  TENANT_REQUIRED: "tenant_required",
  // bridge phát khi máy chưa tham gia phòng nào (`openpocket edge join`).
  NOT_JOINED: "not_joined",
  // worker phát khi tunnel của máy đang chết — web hiện trạng thái chờ.
  TUNNEL_DOWN: "tunnel_down",
  // sai user/mật khẩu phòng (bridge `pair/tenant` + worker RoomGate).
  INVALID_CREDENTIALS: "invalid_credentials",
  // chạm hạn mức rate-limit.
  RATE_LIMITED: "rate_limited",
  // worker không nối được bridge.
  BRIDGE_OFFLINE: "bridge_offline",
  // worker từ chối tạo phòng vì build không mang (hoặc sai) mã mời.
  INVITE_REQUIRED: "invite_required",
  // body JSON hỏng — bridge + worker cùng phát.
  INVALID_BODY: "invalid_body",
  // worker từ chối TẠO PHÒNG vì tên đã có (401 khi sai mật khẩu, 409 khi vừa
  // bị chen) — exe desktop so để hiện "bấm Retry, app tự đổi tên".
  TAKEN: "taken",
  // worker từ chối tạo phòng vì hết 50 slot — exe desktop so để chỉ đường "hỏi chủ worker".
  FULL: "full",
  // worker đang KHOÁ cửa tạo phòng (ALLOW_ROOM_CREATE=false) — exe desktop so
  // để báo chính xác lý do thay vì "lỗi lạ".
  ROOM_CREATE_DISABLED: "room_create_disabled",
};

// --- Bộ tiền tố chìa ----------------------------------------------------------
// Bridge cấp: `owm_` (master, dự phòng admin), `owd_` (thiết bị vĩnh viễn);
// `owt_` là chìa owner của OpenWork desktop (không bao giờ tới browser, nhưng
// vẫn phải bị che trong log). Hai bên dùng chuỗi này để dựng regex RIÊNG theo
// mục đích: web kiểm tra hình dạng chìa dán tay, bridge che mọi biến thể trong
// log — nên chỉ phần Danh sách tiền tố là hợp đồng chung.
export const TOKEN_PREFIX_SOURCE = "(?:owm|owd|owt)_";

/**
 * Dựng link ghép nối chuẩn — CHỖ DUY NHẤT biết hình dạng link.
 *   kind "pair"   -> `${base}/#p=${value}&m=${tenant}`
 *   kind "master" -> `${base}/#t=${value}&m=${tenant}`
 * `tenant` rỗng thì bỏ hẳn `&m=` (link phòng-less — worker sẽ từ chối, nhưng
 * bridge in nó khi máy chưa có phòng để chủ máy vẫn thấy URL thô).
 */
export function buildPairingUrl({ base, kind = "pair", value, tenant = "" }) {
  const hashKey = kind === "master" ? MASTER_TOKEN_HASH : PAIR_CODE_HASH;
  const cleanBase = String(base ?? "").replace(/\/+$/, "");
  const suffix = tenant ? `&${TENANT_HASH_KEY}=${encodeURIComponent(tenant)}` : "";
  return `${cleanBase}/#${hashKey}=${value}${suffix}`;
}
