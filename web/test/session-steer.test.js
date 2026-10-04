// Test logic thuần của lib/session-steer.js (steer = gửi tin xen giữa lúc agent
// đang chạy). Case dưới đây bám sát hai quyết định ghi ở đầu file:
//   1. busy -> gửi ngay (steer), không xếp hàng trong app
//   2. tin chờ + tin mới -> gộp thành MỘT prompt, nối bằng dòng trống
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sendDecision,
  mergeSteerTexts,
  planSteerSends,
  isRetryableSendError,
  pendingStatusVi,
  composerHintVi,
  STEER_MAX_PER_PROMPT,
} from "../src/lib/session-steer.js";

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
  assert.deepEqual(planSteerSends([null, "ok"], {}), ["ok"]);
});

// ---- Chia hàng đợi thành nhiều prompt ----

test("hàng đợi ngắn gộp hết thành một prompt", () => {
  assert.deepEqual(planSteerSends(["a", "b", "c"]), ["a\n\nb\n\nc"]);
  assert.deepEqual(planSteerSends([]), []);
  assert.deepEqual(planSteerSends([null, "  "]), []);
});

test("hàng đợi dài bị CHIA, không dồn hết vào một lượt nặng", () => {
  const many = Array.from({ length: 10 }, (_, i) => `tin ${i + 1}`);
  const plan = planSteerSends(many);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].split("\n\n").length, STEER_MAX_PER_PROMPT);
  assert.equal(plan[1], "tin 9\n\ntin 10");
  // Chia xong không rơi tin nào.
  assert.deepEqual(plan.join("\n\n").split("\n\n"), many);
  // Tuỳ chọn chia tay.
  assert.deepEqual(planSteerSends(many, { maxPerPrompt: 3 }), [
    "tin 1\n\ntin 2\n\ntin 3",
    "tin 4\n\ntin 5\n\ntin 6",
    "tin 7\n\ntin 8\n\ntin 9",
    "tin 10",
  ]);
  // maxPerPrompt rác không được làm treo vòng lặp / mất tin.
  assert.deepEqual(planSteerSends(["a", "b"], { maxPerPrompt: 0 }), ["a\n\nb"]);
  assert.deepEqual(planSteerSends(["a", "b"], {}).length, 1);
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
