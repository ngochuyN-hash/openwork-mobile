// Stream event SSE qua fetch (học ZCode — không dùng EventSource):
//  - auth bằng header Authorization, token không bao giờ nằm trên URL
//  (EventSource không set được header, bản cũ phải dán ?_t=<token> — lộ chìa
//  vào history/log của mọi proxy trung gian)
//  - chủ động nối lại với backoff 1s→16s, chủ động hủy bằng AbortController
//  khi rời trang, không phụ thuộc hành vi reconnect mù của trình duyệt
//  - tự bóc `type` từ JSON: engine opencode phát event KHÔNG TÊN trên dòng
//  `data:` (EventSource của bản cũ không nghe được mấy dòng này)
import { getToken, getTenant } from "../api.js";

function headersFor() {
  const token = getToken();
  const tenant = getTenant();
  const headers = { accept: "text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (tenant) headers["x-owm-tenant"] = tenant;
  return headers;
}

/**
 * Nối 1 lượt: GET stream, bóc từng dòng `data:` và gọi onEvent(type, data).
 * Chỉ thoát khi stream đóng / abort / lỗi fetch — event nghiệp vụ không ném.
 */
async function readOnce(path, { onEvent, onOpen, signal }) {
  const res = await fetch(path, { headers: headersFor(), signal });
  if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
  // Chống hot-loop: nhận HTML (SPA fallback khi path sai) thì coi là lỗi để
  // nhánh backoff xử lý, chứ không ngồi đọc "stream" không bao giờ có event.
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    try {
      await res.body.cancel();
    } catch {}
    throw new Error(`sse not event-stream: ${res.headers.get("content-type") ?? "?"}`);
  }
  onOpen?.();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      // ":keepalive" của bridge và dòng trống/comment — bỏ qua.
      if (!line.startsWith("data: ")) continue;
      let data = null;
      try {
        data = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      onEvent(typeof data?.type === "string" ? data.type : "message", data);
    }
  }
}

/**
 * Vòng nối lại vô hạn với backoff tới khi caller gọi hàm đóng. onOpen chạy
 * mỗi lần stream lên thành công (đẩy hàng đợi offline); onLost chạy khi
 * stream đứt bất kể lý do (refetch full để không standing hình).
 */
export function connectEvents(path, onEvent, { onOpen, onLost } = {}) {
  let stopped = false;
  let attempt = 0;
  let timer = null;
  const ac = new AbortController();

  const open = async () => {
    if (stopped) return;
    try {
      await readOnce(path, { onEvent, onOpen, signal: ac.signal });
      attempt = 0; // server đóng sạch — nối lại ngay không backoff
    } catch {
      /* đứt ngầm / abort — rơi xuống backoff */
    }
    if (stopped || ac.signal.aborted) return;
    onLost?.();
    attempt += 1;
    const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 16_000);
    timer = setTimeout(open, delay);
  };
  open();

  return () => {
    stopped = true;
    clearTimeout(timer);
    ac.abort();
  };
}
