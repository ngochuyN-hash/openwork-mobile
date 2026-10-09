// Khoá seam lỗi (round 4, 09/10): errorSentence/isUnpaired là MỘT chỗ dịch error
// thành câu — trước đây ~35 banner đổ thẳng `String(e.message || e)` ra người
// dùng (lỗi mạng ra tiếng Anh thô), chìa hết hạn thì 4 nơi 4 câu khác nhau.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNPAIRED_SENTENCE,
  classifyNetworkError,
  errorSentence,
  isUnpaired,
  networkErrorMessage,
  unpairedError,
} from "../src/lib/net.js";

test("unpairedError mang đủ cờ, message giữ nguyên để code chưa chuyển vẫn chạy", () => {
  const e = unpairedError();
  assert.equal(e.message, "UNPAIRED");
  assert.equal(e.code, "UNPAIRED");
  assert.equal(e.status, 401);
  assert.ok(isUnpaired(e));
});

test("isUnpaired nhận cả error chỉ có message (bản cũ ném tay không cờ)", () => {
  assert.ok(isUnpaired(new Error("UNPAIRED")));
  assert.ok(!isUnpaired(new Error("other")));
  assert.ok(!isUnpaired(null));
  assert.ok(!isUnpaired(undefined));
});

test("errorSentence: lỗi mạng ra câu tiếng Việt, không để 'Failed to fetch' thô", () => {
  assert.equal(
    errorSentence(new TypeError("Failed to fetch")),
    "Could not reach your computer — check your network/Wi-Fi and try again."
  );
  const timeout = new DOMException("Timeout", "TimeoutError");
  assert.equal(classifyNetworkError(timeout), "timeout");
  assert.equal(
    errorSentence(timeout),
    "Computer not responding (timed out) — the tunnel may be hanging."
  );
});

test("errorSentence: message server nguyên văn, rỗng thì dùng fallback", () => {
  const e = new Error("Folder not found");
  e.status = 404;
  assert.equal(errorSentence(e), "Folder not found");
  assert.equal(errorSentence(new Error(""), "could not load"), "could not load");
});

test("errorSentence: 401 của api.js ra đúng MỘT câu trên toàn app", () => {
  assert.equal(errorSentence(unpairedError()), UNPAIRED_SENTENCE);
  // Bản cũ ném tay Error("UNPAIRED") không cờ — vẫn phải rơi vào cùng câu.
  assert.equal(errorSentence(new Error("UNPAIRED")), UNPAIRED_SENTENCE);
});

test("networkErrorMessage giữ nguyên behavior cũ (abort + rác)", () => {
  assert.equal(networkErrorMessage(new DOMException("x", "AbortError")), "Cancelled.");
  assert.equal(networkErrorMessage({}), "Unknown network error.");
});
