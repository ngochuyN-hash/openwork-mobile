// validateTenantCreate (worker/src/index.js) — 3 luật của cửa tạo phòng tách
// khỏi if-chain (round 5, 11/10) để bắn được không cần mock KV. Ghim ĐÚNG
// hành vi cũ: reserved names, dải secret, làm sạch name.
import test from "node:test";
import assert from "node:assert/strict";

const { validateTenantCreate } = await import("../src/index.js");

test("hợp lệ: user đã normalize, name giữ nguyên, trả đủ bộ ba", () => {
  assert.deepEqual(validateTenantCreate({ user: "My-Room", secret: "abcd1234", name: "My Room" }), {
    user: "my-room", // normalizeTenant: trim + lowercase
    secret: "abcd1234",
    name: "My Room",
  });
});

test("name rỗng thì lấy tên phòng; ký tự xuống dòng/quote bị bóc; quá 60 cắt", () => {
  assert.equal(validateTenantCreate({ user: "pc-1", secret: "abcd1234", name: "" }).name, "pc-1");
  assert.equal(validateTenantCreate({ user: "pc-1", secret: "abcd1234" }).name, "pc-1");
  const dirty = validateTenantCreate({ user: "pc-1", secret: "abcd1234", name: 'A\r\nB"C\'D' });
  assert.equal(dirty.name, "ABCD");
  const long = validateTenantCreate({ user: "pc-1", secret: "abcd1234", name: "x".repeat(100) });
  assert.equal(long.name.length, 60);
});

test("reserved names bị chặn — kể cả 'main' (slot của chủ worker)", () => {
  for (const user of ["main", "admin", "root", "api", "www"]) {
    const checked = validateTenantCreate({ user, secret: "abcd1234" });
    assert.equal(checked.error?.code, "invalid_user", user);
  }
});

test("user sai hình dạng -> invalid_user (sau normalizeTenant, không ném)", () => {
  // "AB" thì HỢP LỆ: normalizeTenant hạ chữ thường trước nên "ab" qua được —
  // luật là normalize-then-check, không phải chặn chữ hoa.
  for (const user of ["", "a", "-abc", "phòng", "a".repeat(33), "has space"]) {
    const checked = validateTenantCreate({ user, secret: "abcd1234" });
    assert.equal(checked.error?.code, "invalid_user", JSON.stringify(user));
  }
  // body rác không được làm ném lỗi.
  assert.equal(validateTenantCreate(null).error?.code, "invalid_user");
  assert.equal(validateTenantCreate({}).error?.code, "invalid_user");
});

test("secret ngoài dải 8-128 hoặc chứa space/quote/:/& -> invalid_secret", () => {
  const bad = ["", "short", "x".repeat(129), "has space", "has'quote", 'has"quote', "has:colon", "has&amp"];
  for (const secret of bad) {
    const checked = validateTenantCreate({ user: "pc-1", secret });
    assert.equal(checked.error?.code, "invalid_secret", JSON.stringify(secret).slice(0, 30));
  }
  assert.equal(validateTenantCreate({ user: "pc-1", secret: "x".repeat(128) }).error, undefined);
});
