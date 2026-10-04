// Logic thuần cho NÉN HỘI THOẠI — tách khỏi chat.jsx để test được, cùng kiểu
// với lib/session-ops.js và lib/chat-stream.js.
//
// Trước đây web không có đường nào nén lịch sử: grep `summarize|compact` trong
// web/src không ra gì (chỉ trúng thẻ <summary> của HTML). Engine thì có sẵn
// `POST /session/:id/summarize`.
//
// Nguồn: source OpenWork desktop (different-ai/openwork, branch dev) —
// apps/app/src/app/lib/opencode-session.ts:152-184 `compactSession()`. App bên
// đó feature-detect `session.summarize` trước, không có thì rơi về
// `session.command({ command: "compact" })` (:176-184). Ta làm y hệt: đường
// summarize là chính, command là dự phòng — hai body khác nhau, xem
// buildSummarizeBody / buildCompactCommandBody.
//
// Ba điều dễ sai, đã đối chiếu từng dòng:
//  1. `summarize` KHÔNG nhận `model` dạng chuỗi "provider/model" như lệnh
//     slash — nó nhận TỪNG field: body { providerID, modelID }.
//  2. `directory` KHÔNG nằm trong body: nó đi qua query ?directory= hoặc header
//     x-opencode-directory. Web chưa từng gửi directory (workspace đã bị scope
//     trong /workspace/:id) nên mặc định bỏ trống.
//  3. Ở engine v1, `Session` KHÔNG có field cost/tokens (chỉ message mới có
//     info.tokens) — nên ngưỡng token ở đây tính từ lượt assistant gần nhất,
//     không phải từ session. Ngưỡng là ước lượng của web, không phải số engine
//     báo; đổi được qua tham số.

// Số lượt tính từ đâu, ngưỡng gợi ý khi nào. Lượt = 1 tin người dùng (kèm
// câu trả lời của agent sau đó), không đếm tin tool/suy luận — nếu đếm từng
// part thì một lượt dài đã vượt ngưỡng.
export const COMPACT_THRESHOLDS = {
  hint: 12, // từ lượt này gợi ý nén
  urgent: 20, // từ lượt này nói gấp
  tokens: 120_000, // token của lượt cuối (input+output+cache.read)
  cooldown: 4, // số lượt tối thiểu kể từ lần nén trước mới gợi ý lại (chặn
  // gợi ý liên tục nếu ai đó hạ ngưỡng hint xuống dưới nó)
};

/** Role của 1 message (shape engine {info:{role}} hoặc phẳng). */
function roleOf(message) {
  return message?.info?.role ?? message?.role ?? "";
}

/** Id của 1 message (shape engine {info:{id}} hoặc phẳng). */
function idOf(message) {
  return message?.info?.id ?? message?.id ?? "";
}

/** Số lượt (tin người dùng) trong transcript. */
export function countUserTurns(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.filter((m) => roleOf(m) === "user").length;
}

/**
 * Engine đánh dấu tin tóm tắt bằng cờ `summary` trên info (tin assistant do
 * session.summarize sinh ra). Nếu bản engine không bật cờ này thì hàm trả null
 * và caller tự đếm bằng số lượt từ lần nén trước — đừng đoán mò.
 */
export function findLastSummaryIndex(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.info?.summary === true) return i;
  }
  return -1;
}

/**
 * Số lượt tính từ sau lần nén gần nhất. `sinceLastCompact` là số lượt UI tự
 * đếm (khi engine không bật cờ summary) — thắng chỗ nào có cờ thì dùng cờ.
 */
export function turnsSinceSummary(messages, sinceLastCompact = null) {
  const idx = findLastSummaryIndex(messages);
  if (idx >= 0) return Math.max(0, countUserTurns(messages) - countUserTurns(messages.slice(0, idx)));
  if (sinceLastCompact == null) return null;
  return Math.max(0, Number(sinceLastCompact) || 0);
}

/**
 * Token của lượt assistant GẦN NHẤT (info.tokens của engine v1:
 * {input, output, reasoning, cache:{read, write}}). Chỉ tính input + output +
 * cache.read — đó là ba khoản engine tính lại mỗi lượt, còn reasoning và
 * cache.write là chi phí phát sinh trong chính lượt đó.
 */
export function lastTurnTokens(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const info = list[i]?.info;
    if (!info || info.role !== "assistant" || !info.tokens) continue;
    const t = info.tokens;
    const cache = t.cache && typeof t.cache === "object" ? t.cache : {};
    return (t.input || 0) + (t.output || 0) + (cache.read || 0);
  }
  return 0;
}

/**
 * Có nên gợi ý nén không.
 *
 * @param {object} input
 * @param {Array}  input.messages        transcript hiện tại
 * @param {boolean} [input.running]      agent đang chạy -> không gợi ý (cũng không
 *                                      nén được: lượt đang stream sẽ lệch)
 * @param {number}  [input.sinceLastCompact] lượt đã trôi qua từ lần nén trước
 * @param {object}  [input.thresholds]   ghi đè COMPACT_THRESHOLDS
 * @returns {{suggest:boolean, level:"none"|"hint"|"urgent", turns:number,
 *            turnsSince:number|null, tokens:number, reason:string}}
 */
export function shouldSuggestCompact({ messages, running = false, sinceLastCompact = null, thresholds = COMPACT_THRESHOLDS } = {}) {
  const t = { ...COMPACT_THRESHOLDS, ...(thresholds ?? {}) };
  const turns = countUserTurns(messages);
  const tokens = lastTurnTokens(messages);
  const since = turnsSinceSummary(messages, sinceLastCompact);
  // Đếm từ lần nén (nếu biết) — nếu không thì đếm từ đầu phiên.
  const effective = since ?? turns;

  let level = "none";
  let reason = "";
  if (running) {
    reason = "agent is running";
  } else if (since != null && effective < (t.cooldown ?? 0)) {
    // Chỉ khi BIẾT đã nén lúc nào mới im — phiên chưa nén bao giờ (`since`
    // null) thì tính từ đầu phiên, không bị cooldown vô lý chặn.
    reason = "just compacted, let the agent continue";
  } else if (effective >= (t.urgent ?? Infinity)) {
    level = "urgent";
    reason = "session is very long";
  } else if (effective >= (t.hint ?? Infinity)) {
    level = "hint";
    reason = "session is long enough";
  } else if (tokens >= (t.tokens ?? Infinity)) {
    // Lượt cuối ăn hết context dù mới chỉ vài lượt -> vẫn nên nén.
    level = "hint";
    reason = "last turn was heavy";
  }

  return {
    suggest: level !== "none",
    level,
    turns,
    turnsSince: since,
    tokens,
    reason,
  };
}

/** Câu gợi ý tiếng Việt cho banner/nút. Rỗng khi chưa tới lúc nén. */
export function compactHint(level, { turnsSince = null } = {}) {
  const n = turnsSince;
  if (level === "urgent") {
    return n ? `This session has ${n} turns — time to compact again, the agent is about to forget the pending work.` : "This session is very long — time to compact again, the agent is about to forget the pending work.";
  }
  if (level === "hint") {
    return n ? `This session has ${n} turns. Compact again so the agent remembers the pending work better.` : "This session is fairly long. Compact again so the agent remembers the pending work better.";
  }
  return "";
}

/** Vì sao KHÔNG nén được lúc này (rỗng = nén được). */
export function compactBlockReason({ running = false, turns = 0, busy = false } = {}) {
  if (busy) return "Already compacting, please wait.";
  if (running) return "Agent is running — stop it before compacting, otherwise the streaming turn will get out of sync.";
  if (turns < 2) return "Only a few messages so far — not worth compacting yet.";
  return "";
}

// ---- Body cho hai đường nén (khác nhau — đừng gộp) ----

// Tách "provider/model" dùng chung với lib/model-behavior.js: cắt ở dấu "/"
// ĐẦU TIÊN, phần sau nguyên vẹn là modelID. Tự viết split("/") lấy hai đoạn
// đầu đã từng làm mất modelID chứa dấu "/" ở giữa (openrouter/anthropic/claude).
import { parseModelValue as parseModelId } from "./model-behavior.js";

/**
 * Body của `POST /session/:id/summarize` — TỪNG field providerID/modelID, KHÔNG
 * phải chuỗi "provider/model", và không kèm directory. Trả null nếu chưa chọn
 * model — engine cần model tường minh, không có thì message treo.
 */
export function buildSummarizeBody(model) {
  const parsed = parseModelId(model);
  return parsed ? { ...parsed } : null;
}

/**
 * Body của đường dự phòng `POST /session/:id/command` với command "compact" —
 * ở đây model LẠI là chuỗi "provider/model" và có kèm arguments (rỗng).
 */
export function buildCompactCommandBody(model) {
  const raw = String(model ?? "").trim();
  const parsed = parseModelId(raw);
  if (!parsed) return null;
  return { command: "compact", arguments: "", model: `${parsed.providerID}/${parsed.modelID}` };
}

/**
 * Path engine tới đường summarize (đã encode, đúng dạng `oc()` của api.js).
 * `directory` đi qua QUERY chứ không nằm trong body; web hiện chưa gửi directory
 * ở đâu cả (workspace đã bị scope trong /workspace/:id) nên mặc định bỏ trống
 * thì không dính dấu "?" thừa.
 */
export function summarizePath(wsId, sid, { directory = "" } = {}) {
  const base =
    `/workspace/${encodeURIComponent(wsId)}/opencode/session/${encodeURIComponent(sid)}/summarize`;
  const dir = String(directory ?? "").trim();
  return dir ? `${base}?directory=${encodeURIComponent(dir)}` : base;
}

// ---- Định dạng phần tóm tắt để hiện ra ----

/**
 * Cắt chuỗi theo CODE POINT, không cắt đôi ký tự. `slice(0, cap)` đếm theo
 * đơn vị UTF-16 nên cắt trúng giữa một emoji (😀 = 2 đơn vị) là ra ký tự
 * hỏng "" — người dùng thấy tóm tắt bị vỡ đúng chỗ đã cắt, tưởng lỗi engine.
 * Đây là cùng lý do lib/session-rename.js có clipByCodePoint.
 */
function clipByCodePoint(value, max) {
  let end = 0;
  let count = 0;
  while (end < value.length && count < max) {
    const cp = value.codePointAt(end);
    end += cp > 0xffff ? 2 : 1; // bước qua TRỌN một ký tự, không dừng giữa cặp thay thế
    count += 1;
  }
  return value.slice(0, end);
}

/**
 * Cắt phần tóm tắt cho màn hình điện thoại. Ưu tiên cắt ở DÒNG (bản tóm tắt
 * là markdown nhiều dòng) và chỉ cắt giữa dòng khi dòng cuối quá dài; luôn
 * thêm "…" khi bị cắt để không ai tưởng là hết nội dung.
 */
export function formatSummaryText(raw, maxChars = 1200) {
  const full = String(raw ?? "").trim();
  const total = full.length;
  if (!full) return { text: "", truncated: false, total: 0 };
  const cap = Math.max(80, Number(maxChars) || 1200);
  if (full.length <= cap) return { text: full, truncated: false, total };
  const cut = clipByCodePoint(full, cap);
  const nl = cut.lastIndexOf("\n");
  const keep = nl > cap * 0.6 ? cut.slice(0, nl) : cut;
  return { text: `${keep.trimEnd()}…`, truncated: true, total };
}

/** Ghép mọi part text của 1 message (giống messageTextOf, nhưng độc lập file). */
function textOf(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim())
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * View model cho thẻ "Tóm tắt" dán trong chat: tin tóm tắt mới nhất (cờ
 * `info.summary`) đã cắt cho vừa điện thoại. Không có tin tóm tắt nào -> null,
 * đừng dựng thẻ rỗng.
 */
export function summaryView(messages, { maxChars = 1200 } = {}) {
  const idx = findLastSummaryIndex(messages);
  if (idx < 0) return null;
  const message = messages[idx];
  const formatted = formatSummaryText(textOf(message), maxChars);
  if (!formatted.text) return null;
  return {
    messageId: idOf(message),
    role: roleOf(message),
    ...formatted,
  };
}