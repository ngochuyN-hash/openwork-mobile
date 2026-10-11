// Ghim shape bản ghi phòng: chỉ chứa sha256 của mật khẩu, KHÔNG chứa bản gốc
// (invariant chung với /api/tenant/create — worker/src/index.js "KV chỉ giữ
// sha256"). Trước đây tenant.mjs put nguyên `{ secret }` plaintext.
// Chạy: node --test worker/test/tenant-record.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RESERVED_TENANT_NAMES, tenantRecord } from "../scripts/tenant-record.mjs";

test("tenantRecord: chỉ chứa secretHash, không còn secret plaintext", () => {
  const secret = "owes_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const rec = tenantRecord(secret, "Phòng của Nam");
  assert.equal(rec.secretHash, createHash("sha256").update(secret, "utf8").digest("hex"));
  assert.ok(!("secret" in rec), "KV không được giữ mật khẩu gốc");
  assert.ok(!JSON.stringify(rec).includes(secret), "bản gốc không lọt vào JSON ở bất kỳ field nào");
  assert.equal(rec.name, "Phòng của Nam");
  assert.ok(Number.isInteger(rec.createdAt));
});

test("RESERVED_TENANT_NAMES khớp danh sách của /api/tenant/create", async () => {
  // Hai đầu phải chặn cùng một danh sách: worker chặn ở validateTenantCreate,
  // script tay chặn ở `add`. So trực tiếp với hằng số worker source.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const m = src.match(/RESERVED_TENANT_NAMES\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, "worker/src/index.js phải khai báo RESERVED_TENANT_NAMES");
  const workerNames = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  assert.deepEqual(
    [...RESERVED_TENANT_NAMES].sort(),
    [...workerNames].sort(),
    "script tay và worker phải chặn cùng danh sách tên"
  );
});
