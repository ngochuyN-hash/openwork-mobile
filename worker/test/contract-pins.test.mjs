// Pins nội bộ worker cho hợp đồng (07/10): nhãn kệ KV chỉ được đặt qua builder
// kvKey, đường /__register đọc từ shared contract. Lớp giá trị canonical + quét
// literal xuyên tầng đã có ở web/test/contract-fixture.test.js — file này là
// lớp giữ worker tự vệ được khi chạy riêng `node --test worker/test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REGISTER_PATH, normalizeTenant } from "../../shared/contract.js";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

test("worker: REGISTER_PATH là /__register và handler đọc qua contract", () => {
  assert.equal(REGISTER_PATH, "/__register");
  const src = readFileSync(join(WORKER_DIR, "src", "index.js"), "utf8");
  assert.ok(src.includes("url.pathname === REGISTER_PATH"), "handler phải so REGISTER_PATH");
  assert.ok(!src.includes('"/__register"'), "worker còn literal đường /__register");
});

test("worker: nhãn kệ KV chỉ sống trong builder kvKey", () => {
  const src = readFileSync(join(WORKER_DIR, "src", "index.js"), "utf8");
  assert.ok(src.includes("const kvKey = {"), "mất builder kvKey");
  // Bỏ khối builder (nơi DUY NHẤT được phép đặt khoá) rồi mới quét.
  const withoutBuilder = src.replace(/const kvKey = \{[\s\S]*?\n\};/, "");
  assert.ok(!/`(?:tenant|machine):\$\{/.test(withoutBuilder), "còn template literal KV key ngoài kvKey");
  assert.ok(!withoutBuilder.includes('"machine:main"'), 'machine:main phải qua kvKey.machine("main")');
  assert.ok(!withoutBuilder.includes('startsWith("machine:")'), "parse prefix phải qua kvKey.machinePrefix");
  assert.ok(!withoutBuilder.includes('prefix: "tenant:"'), "list prefix phải qua kvKey.tenantPrefix");
});

test("worker: normalizeTenant là cùng một nguồn với bridge/web", () => {
  assert.equal(normalizeTenant(null), "");
  assert.equal(normalizeTenant(" Mixed-Case Room "), "mixed-case room");
});
