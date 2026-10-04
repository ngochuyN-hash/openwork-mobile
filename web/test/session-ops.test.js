// Test logic thuần của MỘT session (lib/session-ops.js). Các case dưới đây
// dùng shape THẬT lấy từ engine (đọc /doc + bắn thử trên session nháp 03/10).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRevertCursor,
  hiddenCountByRevert,
  resolveForkBoundaryId,
  messageTextOf,
  isRealMessageId,
  todoProgress,
  questionsForSession,
  questionView,
  buildQuestionAnswers,
  toolRowView,
  toolStatusVi,
  filterCommands,
  formatCost,
  shouldClearRevertCursor,
  questionAnswered,
} from "../src/lib/session-ops.js";

const user = (id, text) => ({ info: { id, role: "user" }, parts: [{ type: "text", text }] });
const bot = (id, text) => ({ info: { id, role: "assistant" }, parts: [{ type: "text", text }] });

// ---- Revert: transcript API trả ĐỦ, client tự cắt từ con trỏ ----

test("revert cắt từ ĐÚNG message con trỏ trở đi (không cắt dư message trước)", () => {
  const list = [user("msg_1", "a"), bot("msg_2", "b"), user("msg_3", "c"), bot("msg_4", "d")];
  const visible = applyRevertCursor(list, "msg_3");
  assert.equal(visible.length, 2);
  assert.equal(visible[1].info.id, "msg_2");
  assert.equal(hiddenCountByRevert(list, "msg_3"), 2);
});

test("revert vô hiệu hoá khi không có con trỏ hoặc message đã bị xoá", () => {
  const list = [user("msg_1", "a"), user("msg_2", "b")];
  assert.equal(applyRevertCursor(list, null), list);
  assert.equal(applyRevertCursor(list, "msg_99"), list); // không tìm thấy -> giữ nguyên
  assert.equal(hiddenCountByRevert(list, "msg_99"), 0);
});

// ---- Fork: engine chép CHẶT TRƯỚC messageID nên phải dò tin kế tiếp ----

test("fork nhánh chứa tin đang bấm: truyền id tin KẾ TIẾP", () => {
  const list = [user("msg_1", "a"), bot("msg_2", "b"), user("msg_3", "c")];
  assert.equal(resolveForkBoundaryId(list, "msg_1"), "msg_2");
  assert.equal(resolveForkBoundaryId(list, "msg_2"), "msg_3");
});

test("fork từ tin cuối = null (fork toàn bộ session)", () => {
  const list = [user("msg_1", "a"), bot("msg_2", "b")];
  assert.equal(resolveForkBoundaryId(list, "msg_2"), null);
});

test("fork bỏ qua id tự sinh phía client khi dò mốc", () => {
  const list = [user("msg_1", "a"), { info: { id: "local-17000", role: "user" }, parts: [] }, user("msg_3", "c")];
  assert.equal(resolveForkBoundaryId(list, "msg_1"), "msg_3");
  assert.equal(isRealMessageId("local-17000"), false);
  assert.equal(isRealMessageId("msg_3"), true);
});

test("fork message không còn trong transcript -> null thay vì ném", () => {
  assert.equal(resolveForkBoundaryId([user("msg_1", "a")], "msg_zz"), null);
});

// ---- Text của message ----

test("messageTextOf ghép part text, bỏ phần rỗng", () => {
  const m = { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "dòng 1" }, { type: "file", filename: "a.png" }, { type: "text", text: "   " }, { type: "text", text: "dòng 2" }] };
  assert.equal(messageTextOf(m), "dòng 1\ndòng 2");
  assert.equal(messageTextOf(null), "");
});

// ---- Todo ----

test("todoProgress đếm đúng và tìm việc đang làm", () => {
  const p = todoProgress([
    { content: "đọc code", status: "completed", priority: "high" },
    { content: "viết test", status: "in_progress", priority: "high" },
    { content: "ship", status: "pending", priority: "low" },
  ]);
  assert.equal(p.total, 3);
  assert.equal(p.done, 1);
  assert.equal(p.pct, 33);
  assert.equal(p.next, "viết test");
  assert.deepEqual(todoProgress([]), { total: 0, done: 0, pct: 0, next: "" });
});

// ---- Câu hỏi của agent ----

test("questionsForSession lọc theo session, chấp nhận id có/không tiền tố ses_", () => {
  const list = [
    { id: "que_1", sessionID: "ses_abc", questions: [] },
    { id: "que_2", sessionID: "abc", questions: [] },
    { id: "que_3", sessionID: "ses_zzz", questions: [] },
  ];
  // Cùng một session viết hai kiểu id (có/không tiền tố) vẫn khớp, giống
  // cách chat.jsx so sánh event session id
  assert.deepEqual(questionsForSession(list, "ses_abc").map((q) => q.id), ["que_1", "que_2"]);
  assert.equal(questionsForSession(list, "ses_khac").length, 0);
});

test("questionView + buildQuestionAnswers đúng hợp đồng answers", () => {
  const v = questionView({
    id: "que_1",
    sessionID: "ses_abc",
    questions: [
      { question: "Chọn nguồn", header: "Nguồn", multiple: true, custom: false, options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
      { question: "Port?", header: "Port", multiple: false, custom: true, options: [{ label: "8080", description: "d" }] },
    ],
  });
  assert.equal(v.items.length, 2);
  assert.equal(v.items[0].multiple, true);
  assert.equal(v.items[0].options[1].label, "B");
  assert.equal(v.items[1].custom, true);
  // answers: mỗi câu một mảng nhãn, đúng thứ tự câu
  assert.deepEqual(buildQuestionAnswers([["A", "B"], "8080"]), [["A", "B"], ["8080"]]);
});

// ---- Tool row ----

test("toolRowView ưu tiên input đặc trưng, không dùng title bash dài", () => {
  const v = toolRowView({
    tool: "bash",
    state: { status: "completed", input: { command: "npm test\nnpm run build" }, output: "ok", title: "npm test npm run build" },
  });
  assert.equal(v.label, "Lệnh");
  assert.equal(v.title, "npm test"); // chỉ dòng đầu
  assert.equal(v.body, "ok");
  assert.equal(toolStatusVi("completed"), "xong");
});

test("toolRowView rút gọn đường dẫn dài của edit/read", () => {
  const v = toolRowView({ tool: "edit", state: { status: "completed", input: { filePath: "C:\\a\\b\\c\\deep\\file.ts" } } });
  assert.equal(v.label, "Sửa file");
  assert.equal(v.title, "…/deep/file.ts");
});

test("toolRowView lấy metadata.preview khi output rỗng (tool vừa xong)", () => {
  const v = toolRowView({ tool: "read", state: { status: "completed", input: {}, output: "", metadata: { preview: "123: abc" } } });
  assert.equal(v.body, "123: abc");
  assert.equal(v.input, null);
});

// ---- Command + cost ----

test("filterCommands lọc theo tên/mô tả, bỏ dấu / ở đầu", () => {
  const commands = [
    { name: "init", description: "guided AGENTS.md setup" },
    { name: "deep-research", description: "research the web" },
    { name: "review", description: "review changes" },
  ];
  assert.deepEqual(filterCommands(commands, "").map((c) => c.name), ["init", "deep-research", "review"]);
  // Giữ thứ tự engine trả về, chỉ lọc + cắt limit
  assert.deepEqual(filterCommands(commands, "/re").map((c) => c.name), ["deep-research", "review"]);
  assert.equal(filterCommands(commands, "zzz").length, 0);
});

test("formatCost rút gọn theo độ lớn, ẩn khi không có", () => {
  assert.equal(formatCost(0), "");
  assert.equal(formatCost(undefined), "");
  assert.equal(formatCost(0.0012), "$0.0012");
  assert.equal(formatCost(1.5), "$1.50");
});
// ---- Hồi quy do tính năng steer (04/10) ----

test("sửa tin xong: con trỏ hoàn tác cắt luôn tin mới nối ở cuối", () => {
  // Đúng shape đang lộ lỗi: transcript đã có bản server, con trỏ trỏ vào tin
  // cũ, tin vừa gửi nối ở CUỐI (id local-*, chưa được server ghi).
  const msgs = [
    { info: { id: "msg_1", role: "user" }, parts: [] },
    { info: { id: "msg_2", role: "user" }, parts: [] },
    { info: { id: "msg_5", role: "user" }, parts: [] },
    { info: { id: "msg_6", role: "assistant" }, parts: [] },
    { info: { id: "local-999", role: "user" }, parts: [] },
  ];
  // Còn con trỏ → tin mới bị cắt, chỉ thấy 2 tin đầu.
  assert.deepEqual(
    applyRevertCursor(msgs, "msg_5").map((m) => m.info.id),
    ["msg_1", "msg_2"],
  );
  // Đã gửi tin mới → phải nhả con trỏ, tin mới hiện lại.
  assert.equal(shouldClearRevertCursor({ sentNewMessage: true, revertMessageId: "msg_5" }), true);
  assert.deepEqual(
    applyRevertCursor(msgs, "").map((m) => m.info.id),
    ["msg_1", "msg_2", "msg_5", "msg_6", "local-999"],
  );
});

test("không gửi tin mới thì giữ nguyên con trỏ hoàn tác", () => {
  // Hoàn tác thuần (không sửa tin) vẫn phải che tin phía sau + hiện thanh
  // "N tin đang ẩn" cho người dùng bấm khôi phục.
  assert.equal(shouldClearRevertCursor({ sentNewMessage: false, revertMessageId: "msg_5" }), false);
  // Chưa có con trỏ thì không việc gì.
  assert.equal(shouldClearRevertCursor({ sentNewMessage: true, revertMessageId: "" }), false);
  assert.equal(shouldClearRevertCursor({}), false);
});

// ---- Câu hỏi agent chỉ có ô tự nhập phải trả lời được (04/10) ----

test("questionAnswered: câu không có lựa chọn, gõ chữ là đủ", () => {
  const view = { items: [{ question: "Chạy môi trường nào?", multiple: false, custom: true, options: [] }] };
  // Trước đây answered luôn false → nút Trả lời khoá vĩnh viện dù đã gõ.
  assert.equal(questionAnswered(view, [[]], ["staging"]), true);
  assert.equal(questionAnswered(view, [[]], ["   "]), false); // chỉ khoảng trắng
  assert.equal(questionAnswered(view, [[]], [""]), false);
});

test("questionAnswered: câu có lựa chọn thì chọn HOẶC gõ đều được", () => {
  const view = { items: [{ question: "Chọn model?", multiple: false, custom: true, options: [{ label: "A" }, { label: "B" }] }] };
  assert.equal(questionAnswered(view, [["A"]], [""]), true); // chọn nhãn
  assert.equal(questionAnswered(view, [[]], ["tự gõ"]), true); // hoặc tự nhập
  assert.equal(questionAnswered(view, [[]], [""]), false); // chưa gì cả
});

test("questionAnswered: nhiều câu thì phải đủ tất cả", () => {
  const view = {
    items: [
      { question: "1?", multiple: false, custom: false, options: [{ label: "x" }] },
      { question: "2?", multiple: false, custom: true, options: [] },
    ],
  };
  // custom/selections đánh chỉ số theo TỪNG câu — 2 câu thì 2 phần tử.
  assert.equal(questionAnswered(view, [["x"], []], ["", ""]), false); // câu 2 chưa gõ
  assert.equal(questionAnswered(view, [["x"], []], ["", "ok"]), true);
});

test("questionAnswered: câu vừa không có lựa chọn vừa không cho tự nhập thì không trả lời được", () => {
  const view = { items: [{ question: "?", multiple: false, custom: false, options: [] }] };
  assert.equal(questionAnswered(view, [[]], ["gõ cũng vậy"]), false);
  // View rỗng/hỏng không được ném.
  assert.equal(questionAnswered(null, [], []), true); // every() trên rỗng = true
});
