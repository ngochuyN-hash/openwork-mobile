// Logic THUẦN cho trạng thái hiển thị ở trang Cài đặt (thiết bị đã ghép +
// hàng tunnel trong bảng kỹ thuật) — tách khỏi pages/settings.jsx để
// `node --test` chạy được không cần DOM.
//
// Vì sao tách: hai chỗ dễ sai đã từng là bug thật.
//   1. `apiRevokeDevice` trả `{ok, devices}` nhưng code gọi nó KHÔNG kiểm tra:
//      `setDevices(devices)` với `devices` undefined làm render vỡ
//      (`devices.length` của undefined) — sập trắng màn Cài đặt sau khi thu hồi
//      một thiết bị. Mọi payload lạ phải rơi về danh sách rỗng, không phải làm
//      hỏng cả trang.
//   2. Bridge gửi `tunnel: {phase, url, streak, nextRetryAt}` (bridge/src/index.js
//      dòng ~396) nhưng bảng kỹ thuật không hiển thị phase — người dùng thấy
//      "URL từ xa: —" mà không hiểu tunnel đang backoff hay đã lên, dù nút
//      "Khởi động lại tunnel" ngay trên đó.

/**
 * Danh sách thiết bị đã ghép, LUÔN là mảng.
 *
 * `payload` có thể là mảng, `{devices: [...]}`, hoặc rác. Trả `[]` cho mọi
 * shape không đúng thay vì ném — màn Cài đặt không được sập vì một response
 * lạ, và "chưa có" vẫn là một câu trả lời đúng.
 */
export function deviceListOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.devices)) return payload.devices;
  return [];
}

/**
 * Nhãn trạng thái tunnel từ `state.tunnel` của bridge.
 *
 * @param {{phase?: string, url?: string, streak?: number, nextRetryAt?: number}|null} tunnel
 * @returns {{label: string, ok: boolean}} `ok` = đang chạy thật (dùng cho badge).
 *
 * `phase` là enum của bridge/src/tunnel.js: "starting" | "up" | "backoff".
 * Không có `tunnel` (bridge cũ, hoặc tunnel bị tắt) -> "không rõ", KHÔNG đoán
 * là chết — cùng nguyên tắc "ước lượng thấp" như openworkFoundOf.
 */
export function tunnelStatusLabel(tunnel) {
  const phase = String(tunnel?.phase ?? "");
  const streak = Math.max(0, Number(tunnel?.streak) || 0);
  if (phase === "up") return { label: "running", ok: true };
  if (phase === "starting") return { label: "starting", ok: false };
  if (phase === "backoff") {
    // `streak` là số lần liên tiếp bị giới hạn (bridge/src/tunnel.js:186) —
    // đưa vào nhãn vì "đang nghỉ" nghe như lỗi một lần, còn "tạm nghỉ sau N
    // lần bị giới hạn" nói đúng tình hình.
    return { label: `backing off (${streak} rate-limited attempts)`, ok: false };
  }
  return { label: "unknown", ok: false };
}

/**
 * Mốc thời gian của thiết bị, luôn là chuỗi đọc được.
 *
 * `new Date(undefined).toLocaleString("vi-VN")` ra chuỗi "Invalid Date" — mà
 * payload thiết bị đến từ JSON qua mạng, không ai đảm bảo `createdAt` luôn có.
 * Trả "—" cho mọi thứ không phải mốc hợp lệ.
 */
export function formatDeviceTime(value) {
  if (value === null || value === undefined || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return "—";
  return d.toLocaleString("vi-VN");
}

/**
 * `state.openwork` có ĐỒNG NHẤT mới sau MỌI lần poll /api/state (JSON parse
 * sinh object mới), nên `useEffect(..., [state.openwork])` chạy lại mỗi 15
 * giây dù nội dung y hệt. Hậu quả: `openworkOverride` — giá trị tạm mà
 * `choosePath` vừa lấy từ POST /api/openwork/path — bị xoá sạch 15 giây sau
 * khi bấm, kể cả khi poll CHƯA kịp thấy thay đổi; màn Cài đặt quay về "chưa
 * thấy exe" và khối chọn đường dẫn mở lại dù người dùng vừa làm đúng.
 *
 * Hàm này so NỘI DUNG các trường UI thật sự dùng, nên effect chỉ xoá override
 * khi /api/state thật sự mang tin khác — đúng ý đồ của effect gốc.
 *
 * @returns {boolean} true khi hai info khác nhau đáng kể.
 */
export function openworkInfoChanged(a, b) {
  const x = a ?? null;
  const y = b ?? null;
  if (x === y) return false;
  if (!x || !y) return true;
  for (const key of ["found", "running", "exe", "version", "source"]) {
    if ((x[key] ?? null) !== (y[key] ?? null)) return true;
  }
  const cx = Array.isArray(x.candidates) ? x.candidates : [];
  const cy = Array.isArray(y.candidates) ? y.candidates : [];
  if (cx.length !== cy.length) return true;
  return cx.some((v, i) => v !== cy[i]);
}

/**
 * Chép text, KHÔNG báo thành công khi thật ra chưa chép được gì.
 *
 * `await navigator?.clipboard?.writeText(t)` với clipboard undefined (http,
 * quyền chưa cấp, browser cũ) trả về `undefined` — `await` của một giá trị
 * không phải promise vẫn resolve, nên code báo "Đã chép" trong khi clipboard
 * chưa từng được ghi. Người dùng tin, sang chỗ khác dán, ra nội dung rỗng rồi
 * tưởng app hỏng. Ở đây kiểm tra API CÓ THẬT trước rồi mới gọi.
 *
 * @param {{writeText: (t: string) => Promise<void>}} clipboard
 * @param {string} text
 * @returns {Promise<boolean>} true = đã chép thật.
 */
export async function tryCopyText(clipboard, text) {
  const value = String(text ?? "");
  if (!value) return false; // không có gì để chép -> đừng báo thành công
  if (!clipboard || typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
