// Helpers thuần format/shape dùng chung — tách khỏi api.js (round 4, 09/10):
// api.js từng đeo kèm mấy helper không liên quan transport, khiến interface
// của module transport nói ba thứ cùng lúc. File này KHÔNG đụng mạng, KHÔNG
// đụng localStorage — node --test khoá trực tiếp được, lib khác import được
// mà không kéo theo client fetch.

/**
 * Bóc wrapper `{data: ...}` của engine.
 *
 * `{data: null}` vẫn trả `null` (không đổi so với bản cũ) vì hàng chục chỗ gọi
 * kiểu `unwrap(p) ?? []` / `unwrap(p) ?? p ?? {}` — trả về chính envelope ở đây
 * làm `.map`/`sortByUpdated` nổ trên object. Chỗ thật sự hỏng trước đây là
 * `data: undefined`: `"data" in payload` khớp rồi trả `undefined`, mất trắng
 * luôn object. Mảng đi qua nguyên vẹn (`"data" in []` là false với mảng rỗng
 * nhưng để rõ ý định thì chặn trước).
 */
export function unwrap(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && "data" in payload) {
    return payload.data === undefined ? payload : payload.data;
  }
  return payload;
}

export function timeAgo(ts) {
  if (!ts) return "";
  const delta = Date.now() - ts;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hr ago`;
  return `${Math.floor(delta / 86_400_000)} days ago`;
}

/** Định dạng dung lượng theo Intl (vi-VN). */
export function formatBytes(bytes) {
  if (bytes == null) return "";
  const nf = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${nf.format(bytes / 1024)} KB`;
  return `${nf.format(bytes / (1024 * 1024))} MB`;
}

/** Uint8Array/ArrayBuffer -> base64 theo chunk (không tràn stack như spread). */
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Bóc tên file từ header content-disposition (ưu tiên filename* UTF-8). */
export function filenameFromDisposition(header) {
  if (!header) return "";
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(String(star[1]).trim().replace(/^"|"$/g, ""));
    } catch {
      return String(star[1]).trim().replace(/^"|"$/g, "");
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() ?? "";
}
