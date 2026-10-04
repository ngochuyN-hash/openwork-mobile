// Tính/nhận diện tiền phiên — logic thuần, tách khỏi chat.jsx để test được,
// đúng kiểu lib/chat-stream.js và lib/session-ops.js.
//
// VÌ SAO PHẢI TỰ TÍNH thay vì đọc thẳng session.cost:
//   chat.jsx:127 làm `setCost(info?.cost ?? 0)` — nhưng ở engine opencode v1
//   Session KHÔNG có field cost/tokens (chỉ AssistantMessage mới có:
//   info.cost + info.tokens{input,output,reasoning,cache{read,write}}). Nên v1
//   `info.cost` luôn là undefined và màn hình không có gì để vẽ.
//   Nguồn thật của tiền là TỔNG cost theo từng tin assistant, lấy từ
//   GET /session/{id}/message (transcript). Engine v2 thì Session mới có
//   `cost`/`tokens` — nên ở đây ưu tiên tổng theo tin, lỡ không có mới rơi về
//   session.cost.
//
// Không có endpoint cost riêng (đã grep apps/server): chỉ đọc được cost/token
// kèm theo message/session, không có /session/{id}/cost.

import { formatCost } from "./session-ops.js";

/**
 * Ép một giá trị JSON lạ (số, chuỗi "0.12") thành số >= 0.
 * Trả null khi vô nghĩa — để phân biệt "không có số" với "bằng 0".
 */
export function toAmount(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Làm tròn để cộng dồn không sinh 0.30000000000000004. */
export function roundCost(n) {
  return Math.round(n * 1e12) / 1e12;
}

/** Cost của MỘT message (null = message này không mang cost, thường là tin user). */
export function messageCostOrNull(message) {
  const info = message?.info ?? message ?? {};
  return toAmount(info.cost);
}

/** Cost của một message, quy về 0 cho tiện cộng. */
export function messageCost(message) {
  return messageCostOrNull(message) ?? 0;
}

/**
 * Token của một message. Engine v1 trả
 * tokens{input, output, reasoning, cache{read, write}}; một số bản cũ đặt
 * cache phẳng (cacheRead/cache_read) và tên kiểu OpenAI (prompt/completion).
 * Nhận hết để không mất số.
 */
export function messageTokens(message) {
  const info = message?.info ?? message ?? {};
  const t = (info.tokens ?? info.usage ?? {}) || {};
  const cache = (t.cache ?? {}) || {};
  const input = toAmount(t.input ?? t.prompt ?? t.input_tokens) ?? 0;
  const output = toAmount(t.output ?? t.completion ?? t.output_tokens) ?? 0;
  const reasoning = toAmount(t.reasoning ?? t.reasoning_tokens) ?? 0;
  const cacheRead = toAmount(cache.read ?? t.cacheRead ?? t.cache_read) ?? 0;
  const cacheWrite = toAmount(cache.write ?? t.cacheWrite ?? t.cache_write) ?? 0;
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  };
}

/** Cộng dồn cost của cả transcript. Không phải mảng thì coi như 0. */
export function sumMessageCost(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return roundCost(list.reduce((sum, m) => sum + messageCost(m), 0));
}

/** Cộng dồn token của cả transcript, từng nhóm một. */
export function sumMessageTokens(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const total = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const m of list) {
    const t = messageTokens(m);
    total.input += t.input;
    total.output += t.output;
    total.reasoning += t.reasoning;
    total.cacheRead += t.cacheRead;
    total.cacheWrite += t.cacheWrite;
    total.total += t.total;
  }
  return total;
}

/**
 * Chọn nguồn tiền của phiên.
 *  - có ít nhất MỘT tin mang cost → cộng theo tin (đúng v1, cũng đúng v2 vì
 *    tổng theo tin vẫn là tiền thật đã tiêu);
 *  - không tin nào có cost → rơi về session.cost (chỉ v2 mới có);
 *  - không có gì → 0, source "none" để UI biết mà ẩn, không hiện "$0.00".
 */
export function resolveSessionCost(session, messages) {
  const list = Array.isArray(messages) ? messages : [];
  let counted = 0;
  let sum = 0;
  for (const m of list) {
    const c = messageCostOrNull(m);
    if (c === null) continue;
    counted += 1;
    sum += c;
  }
  if (counted > 0) return { cost: roundCost(sum), source: "messages", counted };
  const own = toAmount(session?.cost);
  if (own !== null) return { cost: own, source: "session", counted: 0 };
  return { cost: 0, source: "none", counted: 0 };
}

/** Token của phiên: cộng theo tin, thiếu thì lấy session.tokens (v2). */
export function resolveSessionTokens(session, messages) {
  const fromMessages = sumMessageTokens(messages);
  if (fromMessages.total > 0) return fromMessages;
  const t = (session?.tokens ?? {}) || {};
  const cache = (t.cache ?? {}) || {};
  const pick = (v) => toAmount(v) ?? 0;
  const input = pick(t.input ?? t.prompt);
  const output = pick(t.output ?? t.completion);
  const reasoning = pick(t.reasoning);
  const cacheRead = pick(cache.read ?? t.cacheRead);
  const cacheWrite = pick(cache.write ?? t.cacheWrite);
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  };
}

/** Số gọn cho điện thoại: 842 · 12,3K · 1,2Tr (nghìn / triệu, dấu phẩy kiểu VN). */
export function formatTokens(n) {
  const v = toAmount(n) ?? 0;
  if (v === 0) return "0";
  const nf = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) return `${nf.format(v / 1000)}K`;
  return `${nf.format(v / 1_000_000)}Tr`;
}

/**
 * View model cho chỗ hiện tiền ở đầu phiên. `label` rỗng = không có gì để
 * hiện (UI tự ẩn, khỏi in "$0.00" lấm màu).
 */
export function costViewModel(session, messages) {
  const { cost, source, counted } = resolveSessionCost(session, messages);
  const tokens = resolveSessionTokens(session, messages);
  const usd = formatCost(cost);
  const tokenLabel = tokens.total > 0 ? `${formatTokens(tokens.total)} token` : "";
  return {
    cost,
    source,
    counted,
    tokens,
    usd,
    tokenLabel,
    hasCost: cost > 0,
    label: [usd, tokenLabel].filter(Boolean).join(" · "),
  };
}