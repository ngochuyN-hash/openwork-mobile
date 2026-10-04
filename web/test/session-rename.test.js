// Test logic thuần đổi tên phiên (lib/session-rename.js). Các case ở đây bắt
// đúng ba chỗ dễ sai đã ghi ở đầu file lib: rỗng, quá dài, nhiều dòng — cộng
// thêm việc cắt không được đôi emoji.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SESSION_TITLE_LENGTH,
  UNTITLED_SESSION_LABEL,
  RENAME_ERRORS,
  normalizeSessionTitle,
  clipSessionTitle,
  sessionTitleOf,
  isSameSessionTitle,
} from "../src/lib/session-rename.js";

// ---- Không rỗng: title rỗng là yêu cầu HỢP LỆ về HTTP, phiên thành vô danh ----

test("tên rỗng hoặc toàn khoảng trắng thì báo lỗi chứ không gửi đi", () => {
  assert.deepEqual(normalizeSessionTitle(""), { ok: false, error: RENAME_ERRORS.empty });
  assert.deepEqual(normalizeSessionTitle("     "), { ok: false, error: RENAME_ERRORS.empty });
  assert.deepEqual(normalizeSessionTitle("\n\t "), { ok: false, error: RENAME_ERRORS.empty });
  assert.deepEqual(normalizeSessionTitle(undefined), { ok: false, error: RENAME_ERRORS.empty });
  assert.deepEqual(normalizeSessionTitle(null), { ok: false, error: RENAME_ERRORS.empty });
});

test("object/mảng KHÔNG bị ép thành \"[object Object]\"", () => {
  // Khớp phòng thủ của mergeCandidates (lib/openwork-fix.js): chỉ chuỗi và số
  // mới dùng được, dán rác lên title là thêm một dòng rác vào danh sách phiên.
  assert.equal(normalizeSessionTitle({ a: 1 }).ok, false);
  assert.equal(normalizeSessionTitle(["sửa", "bug"]).ok, false);
  assert.equal(normalizeSessionTitle(true).ok, false);
  assert.equal(normalizeSessionTitle(NaN).ok, false);
  // Số thì ép được — nhãn lưu bằng số vẫn là một tên hợp lệ.
  assert.deepEqual(normalizeSessionTitle(2026), { ok: true, title: "2026" });
});

// ---- Trim + dẹp khoảng trắng, giữ khoảng trắng bên trong câu ----

test("trim hai đầu, dẹp khoảng trắng thừa, giữ khoảng trắng giữa từ", () => {
  assert.deepEqual(normalizeSessionTitle("  sửa bug login  "), { ok: true, title: "sửa bug login" });
  assert.deepEqual(normalizeSessionTitle("sửa    bug\t\tlogin"), { ok: true, title: "sửa bug login" });
});

test("Enter lọt vào ô nhập bị gộp thành một dòng", () => {
  assert.deepEqual(normalizeSessionTitle("sửa bug\nlogin"), { ok: true, title: "sửa bug login" });
  assert.deepEqual(normalizeSessionTitle("dòng 1\r\n\r\ndòng 2"), { ok: true, title: "dòng 1 dòng 2" });
  // Không gian mỏng (nbsp) là ký tự \s của JS — cũng phải dẹp, vì bàn phím
  // Android hay dán nó lẫn vào khi người dùng copy từ nơi khác.
  assert.deepEqual(normalizeSessionTitle("sửa bug login"), { ok: true, title: "sửa bug login" });
});

// ---- Giới hạn độ dài ----

test("đúng trần thì qua, vượt trần thì báo lỗi (không cắt âm thầm)", () => {
  const atLimit = "a".repeat(MAX_SESSION_TITLE_LENGTH);
  assert.deepEqual(normalizeSessionTitle(atLimit), { ok: true, title: atLimit });
  const over = normalizeSessionTitle("a".repeat(MAX_SESSION_TITLE_LENGTH + 1));
  assert.deepEqual(over, { ok: false, error: RENAME_ERRORS.tooLong });
  // Trim ĐI TRƯỚC khi đo: "…120 ký tự + 1 space ở đuôi" vẫn hợp lệ, vì space
  // đó không được gửi đi. Đo trước rồi mới trim là người dùng gõ tay bị báo
  // vượt trần một cách vô lý.
  assert.deepEqual(normalizeSessionTitle(`${"a".repeat(MAX_SESSION_TITLE_LENGTH)} `), {
    ok: true,
    title: "a".repeat(MAX_SESSION_TITLE_LENGTH),
  });
});

test("tiêu đề tiếng Việt có dấu đếm theo ký tự, không vướng", () => {
  const full = "ô".repeat(MAX_SESSION_TITLE_LENGTH);
  assert.equal(normalizeSessionTitle(full).ok, true);
  assert.equal(normalizeSessionTitle(`${full}ô`).ok, false);
});

// ---- clipSessionTitle: xem trước, không quyết định có cho lưu ----

test("clipSessionTitle cắt theo ký tự và KHÔNG cắt đôi emoji", () => {
  // 😀 = 1 code point nhưng 2 đơn vị UTF-16: cắt bằng length thì ra "\uD83D".
  const emoji = "😀".repeat(MAX_SESSION_TITLE_LENGTH + 10);
  const clipped = clipSessionTitle(emoji);
  assert.equal([...clipped].length, MAX_SESSION_TITLE_LENGTH);
  assert.equal(clipped, "😀".repeat(MAX_SESSION_TITLE_LENGTH));
  assert.equal(clipped.includes("\uFFFD"), false);
  assert.equal([...clipSessionTitle("😀😀😀", { max: 2 })].length, 2);
});

test("clipSessionTitle dẹp lại sau khi cắt (không để đuôi khoảng trắng)", () => {
  assert.equal(clipSessionTitle("sửa bug   đăng nhập", { max: 8 }), "sửa bug");
  assert.equal(clipSessionTitle("   "), "");
  assert.equal(clipSessionTitle(undefined), "");
});

test("clip không vỡ với chuỗi dài hàng trăm nghìn ký tự", () => {
  // [..str] của chuỗi này là hàng trăm nghìn phần tử — nếu lib dùng spread
  // theo kiểu apply thì vỡ stack; ở đây phải trả lời ngay.
  const huge = "b".repeat(200_000);
  assert.equal(clipSessionTitle(huge).length, MAX_SESSION_TITLE_LENGTH);
});

// ---- Nhãn hiển thị ----

test("sessionTitleOf có nhãn thay thế và tự dẹp chuỗi engine trả về", () => {
  assert.equal(sessionTitleOf({ title: "sửa bug login" }), "sửa bug login");
  assert.equal(sessionTitleOf({}), UNTITLED_SESSION_LABEL);
  assert.equal(sessionTitleOf(null), UNTITLED_SESSION_LABEL);
  assert.equal(sessionTitleOf({ title: "   " }), UNTITLED_SESSION_LABEL);
  assert.equal(sessionTitleOf({ title: "sửa\nbug" }), "sửa bug");
  // Nhãn phải khớp đúng chỗ home.jsx:127 + sessions.jsx:122 đang dùng.
  assert.equal(UNTITLED_SESSION_LABEL, "Untitled");
});

// ---- So sánh tên để khỏi gửi PATCH thừa ----

test("isSameSessionTitle bỏ qua khác biệt do khoảng trắng thừa", () => {
  assert.equal(isSameSessionTitle("sửa bug", "  sửa bug  "), true);
  assert.equal(isSameSessionTitle("sửa bug", "sửa  bug"), true);
  assert.equal(isSameSessionTitle("sửa bug", "sửa lỗi"), false);
  // Tên cũ rỗng + tên mới rỗng: cùng một phiên vô danh, nhưng hàm trả false để
  // UI không khoá nút "Lưu" — người dùng vẫn gõ tên được.
  assert.equal(isSameSessionTitle("", ""), false);
});