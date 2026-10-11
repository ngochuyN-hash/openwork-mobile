import { test } from "node:test";
import assert from "node:assert/strict";
import { installBrowserShim } from "./helpers/shim.js";

// House rule: tests never touch a real bridge / openwork data directory.
installBrowserShim();

const { parsePermanentKey, setTenant, getTenant, getTenantName } = await import(
  "../src/lib/identity-store.js"
);

test("parsePermanentKey: link master #t=...&m=... -> token + tenant đã normalize", () => {
  const parsed = parsePermanentKey("https://app/#t=owd_abcd1234ef56&m=My%20Room");
  assert.equal(parsed.token, "owd_abcd1234ef56");
  assert.equal(parsed.tenant, "my room"); // normalizeTenant: trim + lowercase (luật contract)
});

test("parsePermanentKey: khóa trần không kèm phòng -> tenant rỗng", () => {
  assert.deepEqual(parsePermanentKey("owd_abcdef123456"), { token: "owd_abcdef123456", tenant: "" });
  assert.deepEqual(parsePermanentKey("  owt_0011ff2233  "), { token: "owt_0011ff2233", tenant: "" });
});

test("parsePermanentKey: chuỗi lạ -> null (không ném)", () => {
  assert.equal(parsePermanentKey("junk"), null);
  assert.equal(parsePermanentKey(""), null);
  assert.equal(parsePermanentKey(null), null);
  assert.equal(parsePermanentKey(undefined), null);
});

test("parsePermanentKey: khoảng trắng/newline giữa chừng bị gọt trước khi so khóa trần", () => {
  assert.deepEqual(parsePermanentKey("owd_abcd1234ef56\n1234"), {
    token: "owd_abcd1234ef561234",
    tenant: "",
  });
});

test("setTenant chuẩn hóa qua normalizeTenant (một quy tắc ba tầng)", () => {
  setTenant("  MyRoom  ");
  assert.equal(getTenant(), "myroom");
});
