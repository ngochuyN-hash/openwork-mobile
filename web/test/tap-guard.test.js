import { test } from "node:test";
import assert from "node:assert/strict";
import { createTapGuard } from "../src/lib/tap-guard.js";

test("chạm kép: lượt thứ hai cùng chìa bị chặn cho tới khi nhả", () => {
  const guard = createTapGuard();
  assert.equal(guard.begin(), true);
  assert.equal(guard.begin(), false); // hai chạm trong cùng nhịp render
  guard.end();
  assert.equal(guard.begin(), true); // nhả xong thì chạm kế đi qua được
  guard.end();
});

test("hai chìa khác nhau chạy song song được", () => {
  const guard = createTapGuard();
  assert.equal(guard.begin("card-a"), true);
  assert.equal(guard.begin("card-b"), true); // trả lời hai thẻ permission khác nhau
  assert.equal(guard.begin("card-a"), false); // nhưng cùng một thẻ thì không
  guard.end("card-a");
  assert.equal(guard.begin("card-a"), true);
  guard.end("card-a");
  guard.end("card-b");
});

test("end chìa lạ không phá khoá của chìa đang giữ", () => {
  const guard = createTapGuard();
  assert.equal(guard.begin("send"), true);
  guard.end("abort"); // chìa chưa từng giữ — no-op
  assert.equal(guard.begin("send"), false);
  guard.end("send");
  assert.equal(guard.begin("send"), true);
  guard.end("send");
});

test("clear nhả mọi chìa một lượt (dọn khi rời phiên)", () => {
  const guard = createTapGuard();
  guard.begin("send");
  guard.begin("abort");
  guard.begin("perm-1");
  guard.clear();
  assert.equal(guard.begin("send"), true);
  assert.equal(guard.begin("perm-1"), true);
});

test("khoá đơn và khoá keyed dùng chung một chìa mặc định", () => {
  const guard = createTapGuard();
  assert.equal(guard.begin(), true);
  assert.equal(guard.begin(""), false); // "" chính là chìa mặc định
  guard.end();
});
