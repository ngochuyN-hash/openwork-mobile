// Logic THUẦN cho "gõ tin xen giữa lúc agent đang chạy" (steer), tách khỏi
// pages/chat.jsx để `node --test` chạy được không cần DOM — cùng cách dự án
// làm với lib/session-ops.js và lib/openwork-fix.js.
//
// TÌNH TRẠNG CONSUMER (2026-10-04): ĐÃ NỐI. `send()` ở chat.jsx gọi
// `sendDecision()` để quyết định send/steer/wait, và `mergeSteerTexts()` khi
// flush hàng đợi offline. `pendingStatusVi()`/`composerHintVi()` cho dòng
// trạng thái và placeholder ô gõ.
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
 * Chia hàng đợi chờ thành nhiều prompt, mỗi prompt tối đa `maxPerPrompt` tin.
 *
 * Vì sao không gộp hết thành một: 30 tin chờ dồn vào một lượt sẽ làm lượt đó
 * nặng hơn nhiều so với từng tin một, và người dùng mất khả năng biết tin nào
 * agent đã xử. Cách chia này giữ nguyên hành vi cũ (flushQueue gửi từng tin,
 * chat.jsx:193-209) chỉ gom nhóm cho đỡ tốn lượt.
 *
 * @param {string[]} pending
 * @param {{maxPerPrompt?: number}} [opts]
 * @returns {string[]} danh sách prompt, gửi theo thứ tự
 */
export function planSteerSends(pending, opts = {}) {
  const texts = normalizeTexts(pending);
  const size = Math.max(1, Math.floor(opts?.maxPerPrompt) || STEER_MAX_PER_PROMPT);
  const out = [];
  for (let i = 0; i < texts.length; i += size) {
    out.push(texts.slice(i, i + size).join(JOINER));
  }
  return out;
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
 * Dòng trạng thái dưới danh sách tin (aria-live): đang chạy + có tin chờ.
 * Rỗng = không có gì cần nói.
 */
export function pendingStatusVi({ running, sending, pendingCount } = {}) {
  const parts = [];
  if (running) parts.push(sending ? "agent đang chạy, đang tải file…" : "agent đang chạy…");
  const n = Number(pendingCount) || 0;
  if (n > 0) parts.push(`Đang gửi lại ${n} tin nhắn khi có mạng…`);
  return parts.join(" · ");
}

/** Gợi ý trong ô gõ. Khi busy phải nói rõ tin sẽ CHÈN vào lượt chạy hiện tại. */
export function composerHintVi({ running, sending } = {}) {
  if (sending) return "Đang tải file lên máy…";
  if (running) return "Agent đang chạy — gõ tiếp rồi bấm Gửi, tin sẽ chèn vào lượt này.";
  return "Nhập prompt cho agent…";
}
