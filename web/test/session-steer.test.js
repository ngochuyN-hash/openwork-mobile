// Test logic thuần của lib/session-steer.js (steer = gửi tin xen giữa lúc agent
// đang chạy). Case dưới đây bám sát hai quyết định ghi ở đầu file:
//   1. busy -> gửi ngay (steer), không xếp hàng trong app
//   2. tin chờ + tin mới -> gộp thành MỘT prompt, nối bằng dòng trống
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sendDecision,
  mergeSteerTexts,
  planSteerBatches,
  createQueue,
  queueFor,
  queueSet,
  queueAdd,
  queueRestore,
  sessionBusyFromMap,
  isBusyStatusType,
  shouldRestoreComposer,
  statusLineIsBusy,
  permissionReplyBody,
  isRetryableSendError,
  pendingStatusVi,
  composerHintVi,
  STEER_MAX_PER_PROMPT,
} from "../src/lib/session-steer.js";

/** Chỉ phần prompt của mỗi lô — hàm thật là `planSteerBatches`. */
const prompts = (pending, opts) => planSteerBatches(pending, opts).map((b) => b.prompt);

// ---- Quyết định: busy thì đi đường nào ----

test("busy thì STEER (gửi ngay), rảnh thì send — không bao giờ xếp hàng busy", () => {
  assert.deepEqual(sendDecision({ running: true, text: "thôi dừng lại" }), {
    action: "steer",
    blockedBy: "",
  });
  assert.deepEqual(sendDecision({ running: false, text: "bắt đầu đi" }), {
    action: "send",
    blockedBy: "",
  });
});

test("chưa có gì để gửi thì wait/empty; chỉ file cũng gửi được", () => {
  assert.deepEqual(sendDecision({ running: false, text: "   " }), { action: "wait", blockedBy: "empty" });
  assert.deepEqual(sendDecision({ running: true, text: "", hasFiles: true }), { action: "steer", blockedBy: "" });
  assert.deepEqual(sendDecision({ running: false, text: "", hasFiles: false }), { action: "wait", blockedBy: "empty" });
});

test("đang tải file thì khoá trước, kể cả khi session rảnh", () => {
  // Ưu tiên sending hơn running: bấm gửi giữa lúc đang upload phải bị chặn,
  // không được tạo tin thiếu file.
  assert.deepEqual(sendDecision({ running: false, sending: true, text: "a" }), {
    action: "wait",
    blockedBy: "sending",
  });
  assert.deepEqual(sendDecision({ running: true, sending: true, text: "a" }), {
    action: "wait",
    blockedBy: "sending",
  });
});

// ---- Gộp tin chờ + tin mới ----

test("gộp thành MỘT prompt, nối bằng dòng trống, giữ thứ tự", () => {
  assert.equal(mergeSteerTexts(["tin 1", "tin 2"], "tin mới"), "tin 1\n\ntin 2\n\ntin mới");
  // Không thêm nhãn/đánh số tự chế — nội dung đó agent đọc nhầm thành chỉ dẫn.
  assert.equal(mergeSteerTexts([], "chỉ một tin"), "chỉ một tin");
});

test("gộp bỏ tin rỗng và tin trùng LIỀN KỀ (bấm gửi hai lần)", () => {
  assert.equal(mergeSteerTexts(["  ", "abc"], "abc"), "abc");
  assert.equal(mergeSteerTexts(["abc"], "   "), "abc");
  // Hai tin giống nhau ở hai chỗ khác nhau thì GIỮ — lặp lại là cố ý.
  assert.equal(mergeSteerTexts(["abc", "xyz", "abc"], ""), "abc\n\nxyz\n\nabc");
  // Không có gì để gửi -> chuỗi rỗng (không gửi prompt rỗng lên máy).
  assert.equal(mergeSteerTexts(["  "], ""), "");
});

test("phần tử rác trong hàng đợi không biến thành [object Object]", () => {
  assert.equal(mergeSteerTexts([null, undefined, 42, { a: 1 }, "ok"], ""), "ok");
  assert.deepEqual(planSteerBatches([null, "ok"], {}).map((b) => b.prompt), ["ok"]);
});

// ---- Chia hàng đợi thành nhiều prompt ----

test("hàng đợi ngắn gộp hết thành một prompt", () => {
  assert.deepEqual(prompts(["a", "b", "c"]), ["a\n\nb\n\nc"]);
  assert.deepEqual(prompts([]), []);
  assert.deepEqual(prompts([null, "  "]), []);
});

test("hàng đợi dài bị CHIA, không dồn hết vào một lượt nặng", () => {
  const many = Array.from({ length: 10 }, (_, i) => `tin ${i + 1}`);
  const plan = prompts(many);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].split("\n\n").length, STEER_MAX_PER_PROMPT);
  assert.equal(plan[1], "tin 9\n\ntin 10");
  // Chia xong không rơi tin nào.
  assert.deepEqual(plan.join("\n\n").split("\n\n"), many);
  // Tuỳ chọn chia tay.
  assert.deepEqual(prompts(many, { maxPerPrompt: 3 }), [
    "tin 1\n\ntin 2\n\ntin 3",
    "tin 4\n\ntin 5\n\ntin 6",
    "tin 7\n\ntin 8\n\ntin 9",
    "tin 10",
  ]);
  // maxPerPrompt rác không được làm treo vòng lặp / mất tin.
  assert.deepEqual(prompts(["a", "b"], { maxPerPrompt: 0 }), ["a\n\nb"]);
  assert.deepEqual(prompts(["a", "b"], {}).length, 1);
});

// ---- Lỗi nào mới xếp hàng chờ ----

test("chỉ lỗi mạng/lỗi tạm mới xếp hàng; 4xx của máy thì không", () => {
  assert.equal(isRetryableSendError(new Error("Failed to fetch")), true); // không có status = mất mạng
  assert.equal(isRetryableSendError({ status: 503 }), true); // máy lỗi tạm
  assert.equal(isRetryableSendError({ status: 408 }), true); // timeout
  assert.equal(isRetryableSendError({ status: 429 }), true); // quá tần suất
  assert.equal(isRetryableSendError({ status: 400 }), false); // prompt sai -> gửi lại cũng hỏng
  assert.equal(isRetryableSendError({ status: 401 }), false); // hết chìa
  assert.equal(isRetryableSendError({ status: 403 }), false); // token viewer không được ghi
  assert.equal(isRetryableSendError({ status: 404 }), false);
  assert.equal(isRetryableSendError(null), true);
});

// ---- Chuỗi tiếng Việt cho UI ----

test("dòng trạng thái: đang chạy + có tin chờ thì nói cả hai, rỗng khi không có gì", () => {
  assert.equal(pendingStatusVi({}), "");
  assert.equal(pendingStatusVi({ running: false, pendingCount: 0 }), "");
  assert.equal(pendingStatusVi({ running: true }), "agent đang chạy…");
  assert.equal(
    pendingStatusVi({ running: true, pendingCount: 2 }),
    "agent đang chạy… · Đang gửi lại 2 tin nhắn khi có mạng…"
  );
  assert.equal(
    pendingStatusVi({ running: false, pendingCount: 1 }),
    "Đang gửi lại 1 tin nhắn khi có mạng…"
  );
  assert.equal(
    pendingStatusVi({ running: true, sending: true }),
    "agent đang chạy, đang tải file…"
  );
});

test("ô gõ nói rõ tin sẽ chèn vào lượt đang chạy", () => {
  assert.equal(composerHintVi({}), "Nhập prompt cho agent…");
  assert.equal(composerHintVi({ running: false }), "Nhập prompt cho agent…");
  assert.match(composerHintVi({ running: true }), /chèn vào lượt này/);
  assert.equal(composerHintVi({ running: true, sending: true }), "Đang tải file lên máy…");
});

// ---- Hàng đợi offline: thuộc đúng phiên ----
// Trang chat sống lâu hơn một phiên (đổi phiên chỉ đổi route, không unmount),
// nên hàng đợi nằm trong ref sẽ theo qua mọi phiên. Không gắn nhãn thì tin
// xếp lúc rò mạng ở phiên A được flushQueue của phiên B đẩy vào hội thoại B.

test("tin chờ của phiên A KHÔNG lọt sang phiên B", () => {
  const q = queueAdd(createQueue(""), "ses_A", ["tin của phiên A"]);
  assert.deepEqual(queueFor(q, "ses_A"), ["tin của phiên A"]);
  assert.deepEqual(queueFor(q, "ses_B"), [], "phiên khác phải thấy hàng đợi rỗng");
  // Và phiên B có tin riêng thì hai hàng đợi không lẫn vào nhau
  const q2 = queueAdd(q, "ses_B", ["tin của phiên B"]);
  assert.deepEqual(queueFor(q2, "ses_A"), ["tin của phiên A"]);
  assert.deepEqual(queueFor(q2, "ses_B"), ["tin của phiên B"]);
});

test("gõ ở phiên B KHÔNG được xoá tin đang chờ của phiên A", () => {
  const q2 = queueAdd(queueAdd(createQueue(""), "A", ["tin A"]), "B", ["tin B"]);
  assert.deepEqual(queueFor(q2, "A"), ["tin A"], "tin của A phải còn nguyên");
});

test("tin chờ bỏ tin rỗng và tin trùng liền kề", () => {
  const q = queueAdd(createQueue(""), "A", ["  ", "ok", "ok"]);
  assert.deepEqual(queueFor(q, "A"), ["ok"]);
});

test("nối thêm tin giữ thứ tự thời gian", () => {
  let q = createQueue("A");
  q = queueAdd(q, "A", ["một"]);
  q = queueAdd(q, "A", ["hai"]);
  assert.deepEqual(queueFor(q, "A"), ["một", "hai"]);
});

test("lô hỏng giữa chừng: giữ đúng phần CHƯA gửi, không đoán bừa tin đã đi", () => {
  const q = queueAdd(createQueue("A"), "A", ["một", "hai", "ba"]);
  const batches = planSteerBatches(queueFor(q, "A"), { maxPerPrompt: 2 });
  assert.equal(batches.length, 2);
  // Lô 1 (["một","hai"]) đã được máy nhận, lô 2 hỏng → chỉ "ba" ở lại.
  const restored = queueRestore(queueSet(q, "A", []), "A", batches[1].texts);
  assert.deepEqual(queueFor(restored, "A"), ["ba"]);
});

test("người dùng xếp tin MỚI trong lúc flush đang chạy — không bị mất", () => {
  const q = createQueue("A");
  const flushed = queueSet(q, "A", []); // flushQueue đã dọn hàng đợi cũ
  const withNew = queueAdd(flushed, "A", ["người dùng gõ lúc đang gửi"]);
  // Lô cũ hỏng: phần chưa gửi phải đứng TRƯỚC tin mới (đúng thứ tự thời gian).
  const restored = queueRestore(withNew, "A", ["hai", "ba"]);
  assert.deepEqual(queueFor(restored, "A"), ["hai", "ba", "người dùng gõ lúc đang gửi"]);
});

test("planSteerBatches phủ đúng số tin mà prompts() gửi", () => {
  const pending = Array.from({ length: 9 }, (_, i) => `tin ${i + 1}`);
  const batches = planSteerBatches(pending);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].texts.length, STEER_MAX_PER_PROMPT);
  assert.equal(batches[0].from, 0);
  assert.equal(batches[1].from, STEER_MAX_PER_PROMPT);
  assert.deepEqual(
    batches.flatMap((b) => b.texts),
    pending,
  );
});

// ---- Trạng thái chạy của phiên ----

test("busy đúng cả ba loại engine dùng: busy (v1), running (v2), retry", () => {
  assert.ok(isBusyStatusType("busy"));
  assert.ok(isBusyStatusType("running"));
  assert.ok(isBusyStatusType("retry"));
  assert.equal(isBusyStatusType("idle"), false);
  assert.equal(isBusyStatusType(undefined), false);
});

test("map status tra cả id thô lẫn id có tiền tố ses_", () => {
  assert.equal(sessionBusyFromMap({ ses_A: { type: "busy" } }, "A"), true);
  assert.equal(sessionBusyFromMap({ A: { type: "busy" } }, "A"), true);
  assert.equal(sessionBusyFromMap({ ses_A: { type: "retry" } }, "A"), true);
  assert.equal(sessionBusyFromMap({ ses_A: { type: "idle" } }, "A"), false);
});

test("REGRESSION: map RỖNG nghĩa là xong, không phải 'chưa biết'", () => {
  // Lượt chạy kết thúc: engine trả `{}` và tin `step-finish` đã về, nhưng UI
  // vẫn hiện "agent đang chạy…" với nút Dừng kẹt vĩnh viễn. Nguyên nhân là
  // coi map rỗng như "chưa biết" rồi giữ trạng thái cũ. Engine chỉ liệt kê
  // phiên ĐANG chạy, nên vắng mặt = rảnh.
  assert.equal(sessionBusyFromMap({}, "A"), false);
  assert.equal(sessionBusyFromMap({ ses_B: { type: "busy" } }, "A"), false, "phiên khác chạy không làm phiên này chạy");
});

test("đọc hỏng thì trả undefined (chưa biết) — đừng đoán", () => {
  assert.equal(sessionBusyFromMap(null, "A"), undefined);
  assert.equal(sessionBusyFromMap(undefined, "A"), undefined);
  assert.equal(sessionBusyFromMap("lỗi", "A"), undefined);
  assert.equal(sessionBusyFromMap({ ses_A: {} }, "A"), undefined, "shape lạ thì giữ trạng thái");
});

// ---- Ô gõ sau khi bấm Gửi ----

test("lỗi 4xx (không xếp hàng) -> trả nội dung về ô gõ", () => {
  assert.equal(shouldRestoreComposer({ queued: false }), true);
});

test("mất mạng (đã xếp hàng) -> KHÔNG trả lại, tránh gửi hai lần", () => {
  assert.equal(shouldRestoreComposer({ queued: true }), false);
});

// ---- Spinner ----

test("hàng đợi offline đứng yên thì KHÔNG bật vòng quay", () => {
  assert.equal(statusLineIsBusy({ running: false, sending: false, pendingCount: 3 }), false);
  assert.equal(statusLineIsBusy({ running: true }), true);
  assert.equal(statusLineIsBusy({ sending: true }), true);
});

// ---- Thẻ "Agent xin phép" ----

test("REGRESSION: body phải là {reply}, KHÔNG phải {response}", () => {
  // Engine nhận `{reply: "once"|"always"|"reject"}`:
  // apps/app/tests/opencode-archive-transport.test.ts:73-85 (khoá đúng
  // JSON.stringify({ reply })), opencode-v2-adapter.ts:140, và
  // use-session-interactions.ts:388 là nơi desktop gọi.
  assert.deepEqual(permissionReplyBody("once"), { reply: "once" });
  assert.deepEqual(permissionReplyBody("always"), { reply: "always" });
  assert.deepEqual(permissionReplyBody("reject"), { reply: "reject" });
  assert.equal("response" in permissionReplyBody("once"), false, "field cũ làm engine bỏ qua");
  assert.equal("allow" in permissionReplyBody("once"), false, "allow/deny không phải giá trị engine nhận");
});

test("reply thiếu thì mặc định reject — không để mặc định cho phép", () => {
  assert.deepEqual(permissionReplyBody(), { reply: "reject" });
  assert.deepEqual(permissionReplyBody(undefined), { reply: "reject" });
});
