// Stream event SSE qua fetch (học ZCode — không dùng EventSource):
//  - auth bằng header Authorization, token không bao giờ nằm trên URL
//  (EventSource không set được header, bản cũ phải dán ?_t=<token> — lộ chìa
//  vào history/log của mọi proxy trung gian)
//  - chủ động nối lại với backoff 1s→16s, chủ động hủy bằng AbortController
//  khi rời trang, không phụ thuộc hành vi reconnect mù của trình duyệt
//  - tự bóc `type` từ JSON: engine opencode phát event KHÔNG TÊN trên dòng
//  `data:` (EventSource của bản cũ không nghe được mấy dòng này)
import { HEADER_TENANT } from "../../../shared/contract.js";
import { getToken, getTenant } from "../api.js";

function headersFor() {
  const token = getToken();
  const tenant = getTenant();
  const headers = { accept: "text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  // Header phòng đi qua contract (api.js cũng dùng đúng hằng này) — sồn cuối
  // của candidate 4 review 07/10: literal ở đây từng sống ngoài hợp đồng.
  if (tenant) headers[HEADER_TENANT] = tenant;
  return headers;
}

/**
 * Bóc một FRAME SSE theo đúng chuẩn: gom mọi dòng `data:` trong frame nối bằng
 * "\n" rồi mới JSON.parse một lần (engine opencode phát `data: {...}` — có
 * space — nhưng chuẩn SSE cho phép `data:{...}` không space, và opencode
 * phát cả hai; bản cũ lọc bằng `startsWith("data: ")` nên RƠI IM LẶNG mọi
 * frame không có space, biểu hiện ngoài đời là app đứng im không nhận event).
 *
 * Frame = các dòng giữa hai dòng trống. Comment (`:keepalive`), `event:`,
 * `id:`, `retry:` và dòng rỗng bị bỏ. Frame không có `data:` hoặc JSON hỏng ->
 * null (không ném: rác trên wire không được làm đứt stream).
 */
export function parseSseFrame(frame) {
  const dataLines = [];
  for (const raw of String(frame ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("data:")) continue;
    // Chuẩn SSE: bỏ ĐÚNG MỘT space ngay sau dấu ":" (nếu có), phần còn lại
    // là dữ liệu — kể cả khi nó bắt đầu bằng space thật.
    dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return null;
  const text = dataLines.join("\n");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Tích 1 lượt: GET stream, bóc từng frame `data:` và gọi onEvent(type, data).
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
    // Tách theo ranh giới FRAME (dòng trống), không theo từng dòng: một payload
    // JSON có thể nhiều dòng `data:` và chỉ hợp lệ khi nối lại rồi parse MỘT lần.
    // Một chunk có thể chứa nhiều frame — phải đẩy HẾT ra, không được giữ lại
    // frame cuối rồi bỏ các frame trước.
    for (let frame = takeFrame(buf); frame; frame = takeFrame(buf)) {
      buf = frame.rest;
      emitFrame(frame.text, onEvent);
    }
  }
  // Server đóng giữa chừng: dòng cuối không kịp `\n\n` vẫn là frame hợp lệ,
  // bỏ nó thì mất event cuối mà không có lý do.
  if (buf.trim()) emitFrame(buf, onEvent);
}

/** Cắt frame đầu tiên trong `buf` -> {text, rest} | null. */
export function takeFrame(buf) {
  const at = buf.search(/\r?\n\r?\n/);
  if (at < 0) return null;
  const sep = /\r?\n\r?\n/.exec(buf.slice(at))[0];
  return { text: buf.slice(0, at), rest: buf.slice(at + sep.length) };
}

function emitFrame(text, onEvent) {
  const data = parseSseFrame(text);
  if (data === null) return; // keepalive/comment/rác
  onEvent(typeof data?.type === "string" ? data.type : "message", data);
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
    timer = null;
    ac.abort();
  };
}
