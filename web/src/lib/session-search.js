// Logic thuần cho ô TÌM PHIÊN (tên + nội dung) — tách khỏi pages/search.jsx
// để test được, đúng cách dự án đang làm với lib/session-ops.js và
// lib/chat-stream.js.
//
// Desktop có một ô tìm toàn bộ phiên; web bê nguyên quy tắc xếp hạng đó:
//   1. Khớp trong TÊN phiên luôn đứng trước khớp trong NỘI DUNG hội thoại —
//      người gõ thường nhớ tên mình đặt, chứ không nhớ câu chữ agent trả lời.
//   2. Trong cùng nhóm (cùng khớp tên / cùng khớp nội dung) thì phiên nào vừa
//      được sửa gần nhất đứng trước.
//   3. Trong tên thì vị trí cũng tính: "sửa css" ở đầu tên mạnh hơn "làm sửa css"
//      giữa tên, và cụm từ phải khớp HẾT (mọi từ khoá) mới ra phiên.
//
// Không phân biệt hoa thường; bỏ dấu tiếng Việt thì KHÔNG làm (giống hộp tìm
// của desktop) — người dùng vẫn gõ đúng dấu mình nhìn thấy ở tiêu đề.

import { messageTextOf } from "./session-ops.js";

// Điểm nền cho mỗi từ khoá. Chênh nhau rất xa (60 vs 20) để một phiên khớp
// "vài từ trong tên" vẫn thắng phiên khớp "mọi từ trong nội dung": tổng của
// nhóm nội dung (≤30/từ) không bao giờ chạm mức của nhóm tên (≥60/từ).
const TITLE_TERM = 60;
const CONTENT_TERM = 20;
const TITLE_START = 25; // từ khoá nằm ngay đầu tiêu đề
const TITLE_WORD = 15; // từ khoá bắt đầu một từ (sau khoảng trắng / gạch / dấu)
const REPEAT_CAP = 5; // lặp nhiều lần chỉ cộng tới mức này, không thắng phiên khác

/** Chuẩn hoá ô tìm: bỏ khoảng trắng thừa, gộp khoảng trắng, về chữ thường. */
export function normalizeQuery(query) {
  return String(query ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Từ khoá của một ô tìm (rỗng = chưa gõ gì). */
export function queryTerms(query) {
  const q = normalizeQuery(query);
  return q ? q.split(" ") : [];
}

/** Ký tự đứng trước từ khoá — có nó nghĩa là từ khoá bắt đầu MỘT từ mới. */
const BOUNDARY = /[\s\-_/.,:;!?()[\]]/;

/** Số lần xuất hiện của từ khoá (không chồng lấn) trong một đoạn văn bản. */
export function countMatches(haystack, term) {
  const h = String(haystack ?? "").toLowerCase();
  const t = String(term ?? "").toLowerCase();
  if (!h || !t) return 0;
  let n = 0;
  for (let i = h.indexOf(t); i >= 0; i = h.indexOf(t, i + t.length)) n += 1;
  return n;
}

/** Điểm của MỘT từ khoá trong tiêu đề (0 = không khớp). */
function titleTermScore(lowTitle, term) {
  const idx = lowTitle.indexOf(term);
  if (idx < 0) return 0;
  if (idx === 0) return TITLE_TERM + TITLE_START;
  return BOUNDARY.test(lowTitle[idx - 1]) ? TITLE_TERM + TITLE_WORD : TITLE_TERM;
}

/** Cắt cửa sổ quanh chữ khớp, có "…" hai bên; không khớp thì lấy đầu đoạn. */
function cut(text, start, cap) {
  const end = Math.min(text.length, start + cap);
  const head = start > 0 ? "… " : "";
  const tail = end < text.length ? " …" : "";
  return `${head}${text.slice(start, end).trim()}${tail}`;
}

/**
 * Đoạn trích quanh chỗ khớp để người dùng thấy ngữ cảnh mà không phải mở phiên.
 * Cắt dòng/tab về khoảng trắng trước cho khỏi vỡ dòng giữa card.
 */
export function snippetAround(text, query, max = 140) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const cap = Math.max(24, max);
  const low = flat.toLowerCase();
  let at = -1;
  let len = 0;
  for (const term of queryTerms(query)) {
    const i = low.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = term.length;
    }
  }
  if (at < 0) return cut(flat, 0, cap);
  // Lùi vừa đủ để chữ khớp không bị cắt ở mép cửa sổ. Khi từ khoá DÀU HƠN
  // cửa sổ (người dùng bê nguyên một câu dài vào ô tìm) thì `(cap-len)/2`
  // âm — lùi quá tay, cửa sổ bắt đầu SAU chữ khớp và người dùng thấy một
  // đoạn không liên quan. Trong trường hợp đó chỉ lùi về 0.
  const room = Math.max(0, Math.floor((cap - len) / 2));
  const start = Math.max(0, at - room);
  return cut(flat, start, cap);
}

/** Ghép mọi tin trong 1 phiên thành một chuỗi để quét từ khoá. */
export function sessionContentText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .map((m) => messageTextOf(m))
    .filter(Boolean)
    .join("\n");
}

/** contents[id] nhận cả chuỗi sẵn lọc, lẫn list message thô của engine. */
function contentTextOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return sessionContentText(value);
  return String(value?.text ?? "");
}

/**
 * Lọc + xếp hạng phiên theo ô tìm.
 *
 * @param sessions  [{id, title, time:{updated,created}, wsId?}] — shape engine
 *                  `GET /opencode/session`, thêm `wsId` khi tìm nhiều workspace.
 * @param query     chuỗi người dùng gõ (đã tự chuẩn hoá).
 * @param contents  { [sessionId]: string | {text} | [message] } — nội dung đã
 *                  tải; thiếu thì phiên đó chỉ có thể khớp bằng TÊN.
 * @returns [{id, wsId, title, updatedAt, matchIn:'title'|'content'|'', score, snippet}]
 */
export function searchSessions(sessions, query, { contents = {}, limit = 30 } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const terms = queryTerms(query);
  const rows = [];

  for (const s of list) {
    const id = String(s?.id ?? "");
    const title = String(s?.title ?? "").trim() || "Không tiêu đề";
    const wsId = String(s?.wsId ?? "");
    const updatedAt = Number(s?.time?.updated ?? s?.time?.created ?? 0) || 0;
    // Chưa gõ gì: xếp theo phiên vừa sửa, không tạo kết quả "khớp".
    if (!terms.length) {
      rows.push({ id, wsId, title, updatedAt, matchIn: "", score: 0, snippet: "" });
      continue;
    }
    const low = title.toLowerCase();
    const body = contentTextOf(contents[id]);
    let score = 0;
    let titleHits = 0;
    for (const term of terms) {
      const inTitle = titleTermScore(low, term);
      if (inTitle > 0) {
        score += inTitle;
        titleHits += 1;
        continue;
      }
      const hits = countMatches(body, term);
      if (!hits) {
        score = 0; // thiếu từ này -> phiên này không phải kết quả
        break;
      }
      score += CONTENT_TERM + Math.min(hits, REPEAT_CAP) * 2;
    }
    if (!score) continue;
    const inTitle = titleHits === terms.length;
    rows.push({
      id,
      wsId,
      title,
      updatedAt,
      matchIn: inTitle ? "title" : "content",
      score,
      // Khớp tên thì tiêu đề đã nằm ngay trên dòng đó rồi, chỉ khớp nội dung
      // mới cần đoạn trích làm ngữ cảnh.
      snippet: inTitle ? "" : snippetAround(body, query),
    });
  }

  rows.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const cap = Number.isFinite(limit) ? Math.max(0, limit) : rows.length;
  return rows.slice(0, cap);
}

/**
 * Chọn phiên nào đáng tải nội dung để quét: ưu tiên phiên vừa sửa, bỏ phiên đã
 * có trong cache. Không tải hết được (một workspace có thể vài chục phiên, mỗi
 * phiên một request transcript) — chỉ quét N phiên gần nhất rồi báo rõ với
 * người dùng là mới quét tới đâu.
 */
export function scanPlan(sessions, cached, limit = 12) {
  const done =
    cached instanceof Set
      ? cached
      : new Set(Array.isArray(cached) ? cached.map(String) : Object.keys(cached ?? {}));
  const cap = Math.max(0, Number(limit) || 0);
  return (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s?.id && !done.has(String(s.id)))
    .sort((a, b) => Number(b?.time?.updated ?? 0) - Number(a?.time?.updated ?? 0))
    .slice(0, cap)
    .map((s) => String(s.id));
}

/** Chạy worker với số request cùng lúc giới hạn, giữ đúng thứ tự kết quả. */
export async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const width = Math.min(Math.max(1, Number(limit) || 1), list.length);
  if (!width) return [];
  const out = new Array(list.length);
  let next = 0;
  async function run() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      out[i] = await worker(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: width }, run));
  return out;
}
