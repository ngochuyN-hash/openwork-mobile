// Sự kiện SSE của engine — TÁCH THUẦN khỏi pages/chat.jsx để test được bằng
// `node --test` (chat.jsx là JSX, không import nổi trong Node). Đây là bộ nhận
// dạng event: engine opencode các bản trả tên trường khác nhau, nhận hết để
// khỏi bỏ sót tin.
//
// Protocol event học từ desktop (apps/app session-sync.ts):
//  - message.part.updated: snapshot cộng dồn của MỘT part (chìa part.id)
//  - message.part.delta:   miếng chữ tăng dần của part đó (engine v2)
//  - message.updated:      snapshot cả message (info + parts)
//  - message.removed:      message bị xoá/revert — gọt khỏi transcript
//  - session.idle/errored: chốt run status ngay, khỏi đợi poll
// Engine opencode phát event KHÔNG TÊN trên SSE — type nằm trong JSON.

/** SSE các bản trả tên trường khác nhau — nhận hết để khỏi bỏ sót tin. */
export function eventSessionId(data) {
  if (!data || typeof data !== "object") return "";
  return (
    data.sessionID ??
    data.sessionId ??
    data.session_id ??
    data.properties?.sessionID ??
    data.properties?.sessionId ??
    data.message?.sessionID ??
    data.message?.sessionId ??
    data.part?.sessionID ??
    data.part?.sessionId ??
    ""
  );
}

/** Event không mang session (permission/connection chung) hoặc mang ĐÚNG
 * session đang mở (phớt lờ tiền tố `ses_` khác biến thể) — chấp nhận; khác
 * session thì bỏ. */
export function sameSession(eventSid, currentSid) {
  if (!eventSid) return true; // event chung (permission/connection) — cứ nhận
  if (eventSid === currentSid) return true;
  const strip = (s) => String(s ?? "").replace(/^ses_/, "");
  return strip(eventSid) === strip(currentSid);
}

/** properties của event: SSE phát {type, properties:{...}} nhưng một số bản
 * bóc sẵn — nhận cả hai. */
export function eventProps(data) {
  if (!data || typeof data !== "object") return {};
  const p = data.properties ?? data.part ?? data;
  return p && typeof p === "object" ? p : {};
}
