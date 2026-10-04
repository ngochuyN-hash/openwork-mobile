// Hash router + bóc tham số ghép nối — TÁCH THUẦN khỏi app.jsx/api.js để test
// được bằng `node --test` (app.jsx là JSX, không import nổi trong Node).
//
//   #/                     -> home (session gần đây gộp mọi workspace)
//   #/workspaces           -> danh sách workspace
//   #/search               -> tìm phiên trên MỌI workspace
//   #/ws/:id               -> sessions (workspace)
//   #/ws/:id/search        -> tìm phiên trong workspace này
//   #/ws/:id/chat/:sid     -> chat
//   #/ws/:id/files         -> files
//   #/settings             -> settings
//
// Vì sao cần `safeDecode`: hash là DO NGƯỜI DÙNG / link quét QR đưa vào, không
// phải do app sinh ra. `decodeURIComponent("%E0%A4")` ném URIError — trước đây
// ném thẳng ra giữa lúc render (app.jsx) hoặc lúc import module (main.jsx gọi
// absorbTokenFromHash trước render) nên MỘT link cắt ngang là màn trắng, mất
// luôn cả app chứ không chỉ sai route. Giờ hỏng thì coi như không có phần mã
// hoá và vẫn mở được app.

/** decodeURIComponent mà không ném: giá trị hỏng trả nguyên chuỗi gốc. */
export function safeDecode(value) {
  const raw = String(value ?? "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * `#<key>=GIÁ_TRỊ[&m=PHÒNG]` -> {value, tenant} | null.
 * Key phải là chữ/số (escape trước khi dựng RegExp) và GIÁ_TRỊ phải khác rỗng —
 * hai điều kiện đó giữ cho "không có mã trong link" không bị nhầm thành "mã rỗng".
 */
export function parseHashParam(hash, key) {
  const safeKey = String(key ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!safeKey) return null;
  const match = new RegExp(`^#${safeKey}=([^&]+)(?:&m=([^&]+))?`).exec(String(hash ?? ""));
  if (!match?.[1]) return null;
  return {
    value: safeDecode(match[1]),
    tenant: match[2] ? safeDecode(match[2]) : "",
  };
}

/** Bóc route từ `location.hash`. Route lạ -> home (không bao giờ ném). */
export function parseHashRoute(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  // Cắt ở dấu "?" ĐẦU TIÊN thôi: `split("?")` nuốt mất đuôi khi giá trị
  // query chứa "?" (path file tay gõ vào link), còn `indexOf` giữ nguyên phần
  // còn lại cho URLSearchParams tự giải mã.
  const cut = raw.indexOf("?");
  const path = cut >= 0 ? raw.slice(0, cut) : raw;
  const params = new URLSearchParams(cut >= 0 ? raw.slice(cut + 1) : "");
  const parts = path.split("/").filter(Boolean).map(safeDecode);
  if (parts[0] === "settings") return { view: "settings" };
  if (parts[0] === "workspaces") return { view: "workspaces" };
  if (parts[0] === "search") return { view: "search", wsId: "" };
  if (parts[0] === "ws" && parts[1]) {
    if (parts[2] === "search") return { view: "search", wsId: parts[1] };
    if (parts[2] === "chat" && parts[3]) return { view: "chat", wsId: parts[1], sessionId: parts[3] };
    if (parts[2] === "files") return { view: "files", wsId: parts[1], path: params.get("path") ?? "" };
    return { view: "sessions", wsId: parts[1] };
  }
  return { view: "home" };
}
