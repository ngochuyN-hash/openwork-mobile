// Logic thuần cho MỘT session — tách khỏi chat.jsx để test được, học cách
// dự án vẫn làm với lib/chat-stream.js.
//
// Nguồn: source OpenWork desktop (different-ai/openwork, branch dev) —
// apps/app/src/react-app/domains/session/sync/transcript-reconcile.ts (quy tắc
// revert + mốc fork) và hợp đồng engine opencode kiểm chứng bằng /doc live.
//
// Hai quy tắc dễ sai, đã đối chiếu từng dòng:
//  1. revert: session.revert.messageID là con trỏ, tin khỏi ĐÚNG message đó trở
//     đi bị ẩn (slice(0, idx)), và transcript API vẫn trả về đủ — phía client
//     phải tự cắt, không có chỗ nào server cắt hộ.
//  2. fork: engine chép tin CHẶT TRƯỚC messageID. Muốn "nhánh từ tin M" (bao
//     gồm M) thì phải gửi id của tin KẾ TIẾP M; nếu M là tin cuối thì fork
//     toàn bộ (messageID rỗng).

/** Id thật của message trên server (bỏ qua id tự sinh phía client). */
export function isRealMessageId(id) {
  return typeof id === "string" && id.startsWith("msg_");
}

export function messageIdOf(message) {
  return message?.info?.id ?? message?.id ?? "";
}

export function messageRoleOf(message) {
  return message?.info?.role ?? message?.role ?? "";
}

/** Ghép mọi part text của 1 message (bỏ part rỗng) — dùng cho Sửa / Chép. */
export function messageTextOf(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim())
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * Cắt transcript tại con trỏ revert. Không có con trỏ (hoặc không tìm thấy
 * message — ví dụ vừa bị xoá) thì trả nguyên list như cũ.
 */
export function applyRevertCursor(messages, revertMessageId) {
  const list = Array.isArray(messages) ? messages : [];
  if (!revertMessageId) return list;
  const idx = list.findIndex((m) => messageIdOf(m) === revertMessageId);
  if (idx < 0) return list;
  return list.slice(0, idx);
}

/** Số tin đang bị ẩn sau con trỏ revert (0 = chưa hoàn tác gì). */
export function hiddenCountByRevert(messages, revertMessageId) {
  const list = Array.isArray(messages) ? messages : [];
  const visible = applyRevertCursor(list, revertMessageId);
  return Math.max(0, list.length - visible.length);
}

/**
 * Id cần gửi cho `POST /session/:id/fork` để nhánh TỪ messageId (bao gồm nó).
 * Engine cần tin kế tiếp; nếu messageId là tin cuối thì null = fork toàn bộ.
 * Message client tự sinh (không có trên server) bị bỏ qua khi dò mốc.
 */
export function resolveForkBoundaryId(messages, messageId) {
  const list = Array.isArray(messages) ? messages : [];
  const idx = list.findIndex((m) => messageIdOf(m) === messageId);
  if (idx < 0) return null;
  for (let i = idx + 1; i < list.length; i += 1) {
    const candidate = messageIdOf(list[i]);
    if (isRealMessageId(candidate)) return candidate;
  }
  return null;
}

/** Tiến độ todo của session: engine trả [{content,status,priority}]. */
export function todoProgress(todos) {
  const list = Array.isArray(todos) ? todos : [];
  const done = list.filter((t) => t?.status === "completed").length;
  const current = list.find((t) => t?.status === "in_progress" || t?.status === "pending");
  return {
    total: list.length,
    done,
    pct: list.length ? Math.round((done / list.length) * 100) : 0,
    next: String(current?.content ?? ""),
  };
}

/** Câu hỏi đang chờ của CHÍNH session này. */
export function questionsForSession(questions, sessionId) {
  const list = Array.isArray(questions) ? questions : [];
  const bare = String(sessionId ?? "").replace(/^ses_/, "");
  return list.filter((q) => {
    const sid = String(q?.sessionID ?? "").replace(/^ses_/, "");
    return Boolean(sid) && sid === bare;
  });
}

/** Chuẩn hoá 1 QuestionRequest thành view model cho UI trả lời. */
export function questionView(request) {
  const list = Array.isArray(request?.questions) ? request.questions : [];
  return {
    id: String(request?.id ?? ""),
    items: list.map((q) => ({
      question: String(q?.question ?? ""),
      multiple: Boolean(q?.multiple),
      custom: Boolean(q?.custom),
      options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({
        label: String(o?.label ?? ""),
        description: String(o?.description ?? ""),
      })),
    })),
  };
}

/** Body trả lời: answers = mảng, mỗi câu một mảng nhãn đã chọn (thứ tự câu). */
export function buildQuestionAnswers(selections) {
  return selections.map((labels) => (Array.isArray(labels) ? labels : [labels]).filter(Boolean));
}

// ---- Tool row: tiêu đề ngắn + tiền tố xem nhanh thay vì đổ JSON thô ----

const TOOL_VI = {
  bash: "Lệnh",
  read: "Đọc file",
  write: "Ghi file",
  edit: "Sửa file",
  patch: "Sửa file",
  multiedit: "Sửa file",
  grep: "Tìm trong file",
  glob: "Tìm file",
  list: "Liệt kê thư mục",
  webfetch: "Tải trang",
  websearch: "Tìm web",
  todowrite: "Danh sách việc",
  question: "Hỏi bạn",
  skill: "Kỹ năng",
};

export function toolLabel(tool) {
  return TOOL_VI[tool] ?? tool ?? "tool";
}

function firstLine(value, max) {
  const line = String(value ?? "").split("\n")[0].trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

function shortPath(value) {
  const raw = String(value ?? "").replace(/\\/g, "/");
  const parts = raw.split("/").filter(Boolean);
  return parts.length <= 2 ? raw : `…/${parts.slice(-2).join("/")}`;
}

/**
 * Tiêu đề một dòng cho hàng tool. `state.title` của engine là câu lệnh/bash
 * đầy đủ (rất dài) nên ưu tiên trường input đặc trưng trước, rồi mới tới title.
 */
export function toolTitle(part, max = 52) {
  const tool = part?.tool ?? "";
  const input = part?.state?.input ?? {};
  let raw = "";
  if (tool === "bash") raw = input.command ?? "";
  else if (["read", "write", "edit", "patch", "multiedit"].includes(tool)) raw = shortPath(input.filePath);
  else if (tool === "glob") raw = input.pattern ?? "";
  else if (tool === "grep") raw = input.pattern ?? input.query ?? "";
  else if (tool === "websearch") raw = input.query ?? "";
  else if (tool === "webfetch") raw = input.url ?? "";
  else if (tool === "list") raw = shortPath(input.path);
  if (!raw) raw = part?.state?.title ?? tool;
  return firstLine(raw, max);
}

/** View model cho một hàng tool đã gộp. */
export function toolRowView(part) {
  const state = part?.state ?? {};
  const status = String(state.status ?? "");
  const output = typeof state.output === "string" ? state.output : "";
  const preview = typeof state.metadata?.preview === "string" ? state.metadata.preview : "";
  const input = state.input && Object.keys(state.input).length ? state.input : null;
  return {
    tool: part?.tool ?? "",
    label: toolLabel(part?.tool),
    title: toolTitle(part),
    status,
    // Engine cắt output dài và đẩy vào metadata.preview — dùng cái đó khi
    // output rỗng, nếu không body fold sẽ trống với tool vừa chạy xong.
    body: output || preview,
    input,
  };
}

const STATUS_VI = {
  pending: "đang chờ",
  running: "đang chạy",
  completed: "xong",
  error: "lỗi",
};

export function toolStatusVi(status) {
  return STATUS_VI[status] ?? status;
}

/** Lọc slash command theo tên/mô tả (composer gõ "/"). */
export function filterCommands(commands, query, limit = 8) {
  const list = Array.isArray(commands) ? commands : [];
  const q = String(query ?? "").trim().replace(/^\//, "").toLowerCase();
  if (!q) return list.slice(0, limit);
  return list
    .filter((c) => `${c?.name ?? ""} ${c?.description ?? ""}`.toLowerCase().includes(q))
    .slice(0, limit);
}

/** Chi phí phiên: engine trả `cost` (USD) — hiện "$0.0123" hoặc "—". */
export function formatCost(cost) {
  const n = Number(cost);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
/**
 * Con trỏ hoàn tác còn ý nghĩa không, theo nghĩa: đã có TIN MỚI nối sau nó chưa.
 *
 * `applyRevertCursor` cắt từ đúng vị trí con trỏ trở đi. Tin vừa gửi luôn nối
 * ở CUỐI danh sách nên nằm ngoài lát cắt và biến mất khỏi màn hình — đúng cái
 * lỗi "sửa tin xong thì tin mới biến mất". Vì vậy sau khi tin mới đã vào lịch
 * sử, con trỏ phải được nhả.
 *
 * @returns true nếu nên bỏ con trỏ (đã gửi thành công sau lúc hoàn tác).
 */
export function shouldClearRevertCursor({ sentNewMessage, revertMessageId }) {
  return Boolean(sentNewMessage && revertMessageId);
}

/**
 * Đã trả lời đủ câu hỏi của agent chưa? Mỗi câu phải thoả MỘT trong hai:
 * đã chọn ít nhất một nhãn, hoặc (cho phép tự nhập) đã gõ chữ.
 *
 * Câu KHÔNG có lựa chọn nào mà chỉ có ô tự nhập vẫn phải trả lời được bằng
 * chữ — khoá nút vì "chưa chọn gì" là khoá vĩnh viện (lối thoát duy nhất còn
 * lại là bỏ qua, mà người dùng đã gõ rồi thì họ muốn gửi).
 */
export function questionAnswered(view, selections, custom) {
  const items = Array.isArray(view?.items) ? view.items : [];
  return items.every((item, i) => {
    const picked = Array.isArray(selections?.[i]) && selections[i].length > 0;
    const typed = Boolean(item.custom && String(custom?.[i] ?? "").trim());
    if (!item.options.length) return typed;
    return picked || typed;
  });
}
