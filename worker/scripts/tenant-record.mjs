// Bản ghi phòng KV dùng chung giữa script provisioning (tenant.mjs) và test.
// Tách riêng vì tenant.mjs là CLI có side-effect ở top-level (đọc argv, đòi
// kv-id.txt, process.exit) — không import được vào node --test.
import { createHash } from "node:crypto";

// Tên phòng bị cấm: trùng slot máy chủ `machine:main` của chủ worker hoặc
// tưởng là đường gây hiểu nhầm. /api/tenant/create chặn sẵn danh sách này
// (worker/src/index.js RESERVED_TENANT_NAMES) — script tay cũng phải chặn,
// kẻo chủ worker tự tạo phòng "main" rồi phòng đó /__register đè slot máy chính.
export const RESERVED_TENANT_NAMES = new Set(["main", "admin", "root", "api", "www"]);

/** Bản ghi phòng chuẩn: CHỈ chứa sha256 của mật khẩu (không chứa bản gốc) —
 * cùng invariant với /api/tenant/create (worker/src/index.js: "KV chỉ giữ
 * sha256"). Export để test ghim shape mà không cần wrangler. */
export function tenantRecord(secret, name) {
  return {
    secretHash: createHash("sha256").update(String(secret), "utf8").digest("hex"),
    name,
    createdAt: Date.now(),
  };
}
