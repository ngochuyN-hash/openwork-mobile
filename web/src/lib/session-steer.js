// Logic THUẦN cho "gõ tin xen giữa lúc agent đang chạy" (steer), tách khỏi
// pages/chat.jsx để `node --test` chạy được không cần DOM — cùng cách dự án
// làm với lib/session-ops.js và lib/openwork-fix.js.
//
// TÌNH TRẠNG CONSUMER (2026-10-04): ĐÃ NỐI. `send()` ở chat.jsx gọi
// `sendDecision()` để quyết định send/steer/wait, và `mergeSteerTexts()` khi
// flush hàng đợi offline. `pendingStatus()` cho dòng trạng thái.
//
// ---- HAI QUYẾT ĐỊNH, đọc trước khi đổi ----
//
// 1) BUSY thì GỬI NGAY (steer), KHÔNG xếp hàng trong app.
//    Cơ sở từ source OpenWork (branch dev), đã đối chiếu:
//      - KHÔNG có endpoint steer riêng ở engine v1. Steer = POST
//        prompt_async thường vào session đang busy; engine ghi tin user ngay,
//        trả 204, và vòng chạy đang dở NHẶT tin ở step kế tiếp thay vì từ chối
//        (apps/server/src/opencode-plugins/openwork-extensions-preview.ts:1049-1056,
//        comment nguyên văn; implementation postJson tại :1067-1069).
//      - Desktop có cả hai nút (Enter = xếp hàng, Cmd/Ctrl+Enter = steer) nhưng
//        HAI ĐƯỜNG ĐÓ GỬI CÙNG MỘT PAYLOAD — khác nhau ở tầng UI
//        (apps/app/src/react-app/domains/session/surface/composer/composer.tsx:319-321).
//        "Xếp hàng" của desktop là hàng đợi trong UI, không phải trạng thái ở
//        engine. Chọn steer vì hàng đợi busy tốn UI (phải có nơi xem, bấm rút,
//        và một mốc flush khi session về idle) mà không đổi được gì ở protocol.
//      - Steering giữ nguyên lượt chạy; abort rồi gửi lại thì dừng cả cây
//        session con (apps/app/src/app/lib/opencode-interruption.ts:149-189).
//    Hệ quả: web TRƯỚC ĐÂY chặn gửi khi busy (điều kiện `|| running` trong
//    send()); giờ bấm gửi khi busy đi đường steer theo `sendDecision()`.
//    `delivery: "steer"` mà engine v2 có (V2SessionPromptData) thì KHÔNG dùng
//    được: nó đi qua mount /opencode2 mà bridge không whitelist.
//
// 2) Gộp tin chờ + tin mới thành MỘT prompt, nối bằng DÒNG TRỐNG.
//    Hàng đợi của web là hàng đợi OFFLINE (tin gửi hỏng vì mất mạng,
//    chat.jsx:570-572) — không có hàng đợi busy vì quyết định ở trên.
//    Quy tắc: giữ thứ tự, trim, bỏ tin rỗng, bỏ tin TRÙNG LIỀN KỀ, KHÔNG thêm
//    nhãn/đánh số. Không chèn tiền tố tự chế vì đó là nội dung người dùng không
//    gõ, agent có thể đọc nhầm thành chỉ dẫn thật rồi lặp lại trong câu trả lời.

/** Một prompt gộp tối đa bao nhiêu tin chờ (xem `planSteerSends`). */
export const STEER_MAX_PER_PROMPT = 8;

/** Dấu phân cách giữa các tin được gộp — DÙNG "\n\n" (một dòng trống).
 *  Chat hiện tại cũng vậy: khối file đính kèm nối bằng dòng trống rồi mới tới
 *  phần người gõ (chat.jsx:540-547). */
const JOINER = "\n\n";

function normalizeTexts(pending, incoming) {
  const list = Array.isArray(pending) ? pending : [];
  const out = [];
  for (const raw of [...list, incoming]) {
    // Không ép `String(raw)` cho phần tử lạ: danh sách chờ đi qua ref của React,
    // một phần tử rác không được biến thành dòng "[object Object]" gửi lên máy.
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    if (!text) continue;
    // Bỏ trùng LIỀN KỀ thôi: chặn bấm gửi hai lần / gõ lại đúng câu vừa hỏng,
    // nhưng vẫn giữ hai tin giống nhau ở hai chỗ khác nhau (lặp là cố ý).
    if (out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out;
}

/**
 * Tin mới sẽ đi đường nào khi bấm gửi.
 *
 * - `action: "send"`  — session rảnh, gửi như bình thường, tạo lượt chạy mới.
 * - `action: "steer"` — agent đang chạy, gửi NGAY: engine tự chèn tin vào lượt
 *   đang dở ở step kế tiếp, không cần abort.
 * - `action: "wait"`  — chưa gửi được, `blockedBy` nói vì sao.
 *
 * @param {{running?: boolean, sending?: boolean, text?: string, hasFiles?: boolean}} input
 * @returns {{action: "send"|"steer"|"wait", blockedBy: ""|"empty"|"sending"}}
 */
export function sendDecision({ running, sending, text, hasFiles } = {}) {
  if (sending) return { action: "wait", blockedBy: "sending" };
  const hasText = typeof text === "string" && text.trim() !== "";
  if (!hasText && !hasFiles) return { action: "wait", blockedBy: "empty" };
  return running ? { action: "steer", blockedBy: "" } : { action: "send", blockedBy: "" };
}

/**
 * Gộp hàng đợi chờ với tin vừa gõ thành MỘT chuỗi prompt.
 * Tin mới luôn nối CUỐI (giữ đúng thứ tự thời gian), trả "" nếu không còn gì.
 */
export function mergeSteerTexts(pending, incoming = "") {
  return normalizeTexts(pending, incoming).join(JOINER);
}

/**
 * Chia hàng đợi chờ thành nhiều lô, mỗi lô tối đa `maxPerPrompt` tin.
 *
 * Vì sao không gộp hết thành một: 30 tin chờ dồn vào một lượt sẽ làm lượt đó
 * nặng hơn nhiều so với từng tin một, và người dùng mất khả năng biết tin nào
 * agent đã xử.
 *
 * @returns {{prompt: string, texts: string[], from: number}[]} danh sách lô,
 *   kèm số tin mỗi lô phủ để lô hỏng giữa chừng biết chừng nào tin đã ĐI và
 *   chừng nào phải GIỮ (không đoán bừa).
 */
export function planSteerBatches(pending, opts = {}) {
  const texts = normalizeTexts(pending);
  const size = Math.max(1, Math.floor(opts?.maxPerPrompt) || STEER_MAX_PER_PROMPT);
  const out = [];
  for (let i = 0; i < texts.length; i += size) {
    const slice = texts.slice(i, i + size);
    out.push({ prompt: slice.join(JOINER), texts: slice, from: i });
  }
  return out;
}

// ---- Hàng đợi offline: thuộc đúng phiên đã gõ ----
//
// Hàng đợi nằm trong ref của trang chat, mà trang chat SỐNG LÂU hơn một phiên
// (đổi phiên chỉ đổi route, không unmount). Nếu không gắn nhãn phiên, lúc rò
// mạng ở phiên A rồi người dùng chuyển sang phiên B, hàng đợi A sẽ được
// `flushQueue` của B đẩy vào ĐÚNG phiên B — tin của phiên A nằm trong hội
// thoại của phiên B.
//
// Giữ theo BẢN ĐỒ sessionId -> tin, không phải một danh sách đơn: bấm qua
// phiên B rồi lại mất mạng và gõ ở B sẽ KHÔNG được phép xoá mất tin đang chờ
// của A.

/** Hàng đợi rỗng (null = chưa có tin chờ nào ở phiên nào). */
export function createQueue(sessionId = "", texts = []) {
  const sid = String(sessionId ?? "");
  if (!sid && !(Array.isArray(texts) && texts.length)) return { bySession: {} };
  return { bySession: { [sid]: normalizeTexts(texts) } };
}

function bucket(queue, sessionId, create = false) {
  const bySession = queue?.bySession && typeof queue.bySession === "object" ? queue.bySession : {};
  const sid = String(sessionId ?? "");
  if (create && !bySession[sid]) return { bySession: { ...bySession, [sid]: [] } };
  return { bySession };
}

/** Tin chờ của ĐÚNG phiên này — hàng đợi phiên khác trả về rỗng. */
export function queueFor(queue, sessionId) {
  const list = bucket(queue, sessionId).bySession[String(sessionId ?? "")];
  return Array.isArray(list) ? list : [];
}

/** Thay cả hàng đợi của phiên (chuẩn hoá: bỏ rỗng, bỏ trùng liền kề). */
export function queueSet(queue, sessionId, texts) {
  const sid = String(sessionId ?? "");
  const next = { ...bucket(queue, sid, true).bySession };
  const clean = normalizeTexts(texts);
  if (clean.length) next[sid] = clean;
  else delete next[sid];
  return { bySession: next };
}

/** Nối thêm tin vào hàng đợi của phiên. */
export function queueAdd(queue, sessionId, texts) {
  const sid = String(sessionId ?? "");
  return queueSet(queue, sid, [...queueFor(queue, sid), ...(Array.isArray(texts) ? texts : [texts])]);
}

/**
 * Đặt lại phần CHƯA gửi của một lượt flush.
 *
 * Lúc flush bắt đầu, hàng đợi cũ đã bị dọn sạch; trong lúc chờ, người dùng có
 * thể xếp thêm tin mới (mất mạng lúc đó) — những tin đó nằm ở `queue` và phải
 * được GIỮ. `unsent` phải đứng TRƯỚC chúng: người dùng gõ trước, gửi sau.
 */
export function queueRestore(queue, sessionId, unsent) {
  const sid = String(sessionId ?? "");
  const added = queueFor(queue, sid);
  // Dọn ô của phiên này rồi viết lại theo đúng thứ tự thời gian.
  return queueSet(queue, sid, [...(Array.isArray(unsent) ? unsent : []), ...added]);
}

// ---- Trả lời "Agent xin phép" ----

/**
 * Body đúng cho `POST /permission/:id/reply`.
 *
 * Engine nhận `{ reply: "once" | "always" | "reject" }` — KHÔNG phải
 * `{ response: "allow" | "deny" }`. Đối chiếu:
 *  - apps/app/tests/opencode-archive-transport.test.ts:73-85 khoá đúng body
 *    `JSON.stringify({ reply })` cho cả ba giá trị;
 *  - apps/app/src/app/lib/opencode-v2-adapter.ts:140 `type PermissionReply =
 *    "once" | "always" | "reject"`;
 *  - apps/app/src/react-app/domains/session/sync/use-session-interactions.ts:388
 *    là nơi desktop gọi, cũng truyền `reply`.
 *
 * Web trước đây gửi field `response` với giá trị `allow`/`deny` — engine bỏ
 * qua, coi như chưa trả lời, và agent treo ở bước xin phép mãi mãi: bấm
 * "Cho phép" xong thẻ vẫn còn, nút không có phản ứng gì.
 *
 * @param {"once"|"always"|"reject"} reply
 */
export function permissionReplyBody(reply) {
  return { reply: String(reply ?? "reject") };
}

// ---- Trạng thái chạy của phiên ----

/** Engine báo loại nào coi là "đang chạy". Nguồn: apps/app/src/react-app/
 *  domains/session/status/session-activity-store.ts:112-125 — `busy` (v1),
 *  `running` (v2, xem apps/server/src/opencode-v2-read-adapter.ts:46-50) và
 *  `retry` (đang chờ thử lại sau lỗi) đều là chưa xong. */
export function isBusyStatusType(type) {
  const t = String(type ?? "");
  return t === "busy" || t === "running" || t === "retry";
}

/**
 * Phiên này có đang chạy không, đọc từ map `/session/status` của engine.
 *
 * Key của map có thể là id thô lẫn id đã gắn tiền tố `ses_` (engine trả về
 * tuỳ bản), nên tra cả hai — bỏ sót một bên là nút Dừng nhấp nháy.
 *
 * Phân biệt hai kiểu "không thấy":
 * - Map RỖNG `{}` = engine nói KHÔNG có phiên nào chạy. Đây là tin đúng, phải
 *   trả `false`. Trả `undefined` ở đây là nút Dừng kẹt vĹnh viễn sau khi
 *   lượt chạy xong: engine đã trả `{}`, tin `step-finish` đã về, mà UI vẫn
 *   hiện "agent đang chạy…".
 * - CÓ entry cho phiên nhưng shape không nhận ra = chưa đủ thông tin, để caller
 *   giữ trạng thái hiện tại thay vì dập tắt mù.
 */
export function sessionBusyFromMap(map, sessionId) {
  if (!map || typeof map !== "object") return undefined; // không đọc được: caller giữ trạng thái
  const sid = String(sessionId ?? "");
  const direct = map[sid] ?? map[`ses_${sid}`];
  // Engine chỉ liệt kê phiên ĐANG chạy; phiên không có trong map là rảnh.
  if (direct === undefined) return false;
  if (typeof direct !== "object" || typeof direct.type !== "string") return undefined; // shape lạ: đừng đoán
  return isBusyStatusType(direct.type);
}

/**
 * Lỗi gửi có nên đẩy vào hàng đợi chờ không?
 *
 * Chỉ lỗi MẠNG mới xếp hàng. Lỗi HTTP 4xx là máy đã trả lời và nói không —
 * xếp hàng rồi gửi lại y hệt chỉ để hỏng lần nữa, và người dùng thấy dòng
 * "sẽ gửi lại" trong khi không bao giờ gửi được. Ngoại lệ 408/429 là lỗi tạm
 * thời thì vẫn xếp hàng.
 *
 * Lỗi không có `status` = `fetch` chết giữa đường (offline, tunnel đứt) → xếp.
 *
 * @param {unknown} err
 */
export function isRetryableSendError(err) {
  const status = Number(err?.status);
  if (!Number.isFinite(status) || status <= 0) return true;
  if (status === 408 || status === 429) return true;
  return status < 400 || status >= 500;
}

// ---- Chuỗi tiếng Việt cho UI (chỗ gọi nằm ở chat.jsx) ----

/**
 * Ô gõ sau khi bấm Gửi: có nên trả nội dung đã xoá về không?
 *
 * Mất mạng giữa đường thì tin đã nằm trong hàng đợi và sẽ tự đi khi có mạng
 * — dựng lại trong ô gõ chỉ khiến người dùng tưởng phải bấm Gửi lần nữa (thà
 * gửi hai lần). Nhưng lỗi MÁY ĐÃ TỪ CHỐI (4xx) thì tin sẽ không bao giờ đi —
 * phải trả lại ô gõ để họ sửa rồi gửi lại, chứ im lặng xoá mất.
 */
export function shouldRestoreComposer({ queued }) {
  return !queued;
}

/**
 * Dòng trạng thái dưới danh sách tin (aria-live): đang chạy + có tin chờ.
 * Rỗng = không có gì cần nói.
 */
export function pendingStatus({ running, sending, pendingCount } = {}) {
  const parts = [];
  if (running) parts.push(sending ? "agent is running, uploading files…" : "agent is running…");
  const n = Number(pendingCount) || 0;
  if (n > 0) parts.push(`Resending ${n} messages when back online…`);
  return parts.join(" · ");
}

/**
 * Dòng trạng thái có thực sự đang "chạy" không — quyết định có hiện spinner.
 *
 * Hàng đợi offline đứng yên cho tới lúc có mạng: bật vòng quay cho nó là nói
 * dối người đọc bằng mắt (và screen reader đọc "đang tải" rồi im luôn).
 */
export function statusLineIsBusy({ running, sending, pendingCount } = {}) {
  return Boolean(running) || Boolean(sending);
}
