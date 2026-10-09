// Khoá lib/load-guard (round 4, 09/10): MỘT primitive chống race thay 4 dạng
// tự chế từng lệch nhau ở files/home/search/sessions (search không abort,
// sessions có gen theo workspace, home có cờ alive...).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoadGuard } from "../src/lib/load-guard.js";

test("begin mới hơn làm token cũ thành stale", () => {
  const guard = createLoadGuard();
  const a = guard.begin();
  assert.ok(!guard.stale(a));
  const b = guard.begin();
  assert.ok(guard.stale(a));
  assert.ok(!guard.stale(b));
});

test("mỗi kind đếm lượt riêng — begin kind kia không làm token này stale", () => {
  const guard = createLoadGuard();
  const s = guard.begin("sessions");
  const st = guard.begin("statuses");
  assert.ok(!guard.stale(s));
  assert.ok(!guard.stale(st));
  const s2 = guard.begin("sessions");
  assert.ok(guard.stale(s));
  assert.ok(!guard.stale(s2));
  assert.ok(!guard.stale(st), "begin('sessions') không được làm token 'statuses' stale");
});

test("invalidate làm mọi token (mọi kind) stale", () => {
  const guard = createLoadGuard();
  const a = guard.begin("sessions");
  const b = guard.begin("statuses");
  guard.invalidate();
  assert.ok(guard.stale(a));
  assert.ok(guard.stale(b));
  const c = guard.begin();
  assert.ok(!guard.stale(c));
});

test("begin hủy controller lượt cũ cùng kind (abort) — và chỉ cùng kind", () => {
  const guard = createLoadGuard();
  const a = guard.begin("sessions");
  const other = guard.begin("statuses");
  const b = guard.begin("sessions");
  assert.equal(a.signal.aborted, true, "lượt cũ cùng kind phải bị hủy");
  assert.equal(b.signal.aborted, false);
  assert.equal(other.signal.aborted, false, "kind khác không bị hủy lây");
  assert.equal(guard.begin().signal.aborted, false, "kind mặc định là hàng đợi riêng");
});

test("invalidate hủy mọi request đang bay", () => {
  const guard = createLoadGuard();
  const a = guard.begin("sessions");
  const b = guard.begin("statuses");
  guard.invalidate();
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, true);
});

test("stale(token rỗng) là stale — phòng caller truyền null/undefined", () => {
  const guard = createLoadGuard();
  assert.ok(guard.stale(null));
  assert.ok(guard.stale(undefined));
});
