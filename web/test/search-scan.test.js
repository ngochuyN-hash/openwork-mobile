// Test logic thuần của trạng thái trang Tìm phiên (lib/search-scan.js) —
// dòng hint + nhánh <Empty> + cách gộp cache nội dung.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeContents, scanState } from "../src/lib/search-scan.js";

// ---- phase: điều kiện chọn <Empty> ----

test("chưa gõ gì -> idle, không bao giờ là phase khác", () => {
  for (const scanning of [0, 3]) {
    const r = scanState({ debounced: "", resultCount: 99, scanning, scanned: 0, totalSessions: 12 });
    assert.equal(r.phase, "idle");
  }
  assert.equal(scanState({}).phase, "idle");
  assert.equal(scanState({ debounced: "   " }).phase, "idle");
});

test("có kết quả -> none (vẽ danh sách), kể cả khi vẫn đang quét", () => {
  const r = scanState({ debounced: "css", resultCount: 3, scanning: 5, scanned: 0, totalSessions: 12 });
  assert.equal(r.phase, "none");
  assert.match(r.hint, /3 kết quả/);
  assert.match(r.hint, /đang quét 5 phiên/);
});

test("chưa có kết quả + đang quét -> scanning, KHÔNG kết luận 'không tìm thấy'", () => {
  const r = scanState({ debounced: "css", resultCount: 0, scanning: 12, scanned: 0, totalSessions: 40 });
  assert.equal(r.phase, "scanning");
  assert.match(r.hintText, /chờ thêm chút/);
});

test("quét xong mà không khớp -> empty, nói rõ đã quét tới đâu", () => {
  const r = scanState({ debounced: "zzz", resultCount: 0, scanning: 0, scanned: 12, totalSessions: 40 });
  assert.equal(r.phase, "empty");
  assert.match(r.hintText, /12\/40/);
});

test("quét hết mà vẫn không khớp -> empty nhưng không còn câu 'mới quét'", () => {
  const r = scanState({ debounced: "zzz", resultCount: 0, scanning: 0, scanned: 40, totalSessions: 40 });
  assert.equal(r.phase, "empty");
  assert.equal(/Mới quét/.test(r.hintText), false);
});

test("scanning kẹt ở số cũ là bug: hint không được nói 'đang quét' khi không quét", () => {
  // phase phải quyết được từ 4 con số — không phụ thuộc chỗ nào "vừa đặt cờ".
  const idle = scanState({ debounced: "css", resultCount: 0, scanning: 0, scanned: 0, totalSessions: 12 });
  assert.equal(idle.phase, "empty");
  assert.equal(/đang quét/.test(idle.hint), false);
});

test("hint đổi đúng: quét xong thì nhắc đã quét bao nhiêu", () => {
  const busy = scanState({ debounced: "a", resultCount: 1, scanning: 4, scanned: 8, totalSessions: 30 });
  assert.match(busy.hint, /đang quét 4 phiên/);
  assert.equal(/đã quét/.test(busy.hint), false);
  const done = scanState({ debounced: "a", resultCount: 1, scanning: 0, scanned: 12, totalSessions: 30 });
  assert.match(done.hint, /đã quét nội dung 12 phiên/);
});

test("số rác không làm vỡ phase", () => {
  const r = scanState({ debounced: "a", resultCount: NaN, scanning: -5, scanned: undefined, totalSessions: "12" });
  assert.ok(["none", "scanning", "empty", "idle"].includes(r.phase));
});

// ---- mergeContents ----

test("mergeContents ghép transcript mới vào cache, không mất mục cũ", () => {
  const next = mergeContents({ a: "A" }, [{ sid: "b", text: "B" }], new Set(["a", "b"]));
  assert.deepEqual(next, { a: "A", b: "B" });
});

test("mergeContents LOẠI session của workspace trước (đổi workspace giữa lúc quét)", () => {
  // Cache còn sót "old1" từ workspace trước; workspace mới chỉ có "new1".
  const next = mergeContents({ old1: "x", new1: "y" }, [{ sid: "new1", text: "z" }], new Set(["new1"]));
  assert.equal("old1" in next, false);
  assert.equal(next.new1, "z");
});

test("mergeContents bỏ kết quả quét đến muộn sau khi đã đổi phạm vi", () => {
  const next = mergeContents({}, [{ sid: "stale", text: "cũ" }], new Set(["new1"]));
  assert.equal("stale" in next, false);
});

test("mergeContents chịu được payload rác", () => {
  assert.deepEqual(mergeContents(null, null, null), {});
  assert.deepEqual(mergeContents(undefined, [null, { text: "no sid" }], new Set()), {});
  assert.equal(mergeContents({}, [{ sid: "a", text: undefined }], new Set(["a"])).a, "");
});

test("mergeContents ghi đè đúng phiên bị quét lại", () => {
  const next = mergeContents({ a: "cũ" }, [{ sid: "a", text: "mới" }], new Set(["a"]));
  assert.equal(next.a, "mới");
});
