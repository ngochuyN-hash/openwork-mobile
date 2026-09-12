#!/usr/bin/env node
// Cấp / quản lý "phòng" (tài khoản multi-tenant) trên Cloudflare KV.
// Chạy tại máy CHỦ WORKER (cần wrangler đã đăng nhập): cd worker rồi:
//   node scripts/tenant.mjs add <user> "Tên hiển thị" [địa-chỉ-worker]
//   node scripts/tenant.mjs list
//   node scripts/tenant.mjs revoke <user>
// Cặp <user>/<mật khẩu> in ra dùng được cho CẢ HAI đầu của bạn ấy:
//   - máy PC : openpocket edge join <địa-chỉ-worker>
//   - web    : tab "Đăng nhập"
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(DIR, "..");

let namespaceId = "";
try {
  const jsonc = readFileSync(join(WORKER_DIR, "wrangler.jsonc"), "utf8");
  namespaceId = jsonc.match(/"id"\s*:\s*"([0-9a-f]+)"/)?.[1] ?? "";
} catch {}
if (!namespaceId) {
  console.error("Không đọc được KV namespace id từ wrangler.jsonc");
  process.exit(1);
}

const DEFAULT_WORKER_URL = "https://YOUR-WORKER.workers.dev";
const TENANT_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

function kv(...args) {
  const result = spawnSync("npx", ["wrangler", "kv", "key", ...args, "--namespace-id", namespaceId, "--remote"], {
    cwd: WORKER_DIR,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(result.stdout || "");
    console.error(result.stderr || "wrangler thất bại");
    process.exit(1);
  }
  return result.stdout;
}

const [, , action, user, ...rest] = process.argv;

if (action === "add") {
  const name = String(user ?? "").toLowerCase();
  if (!TENANT_RE.test(name)) {
    console.log('Dùng: node scripts/tenant.mjs add <user> "Tên hiển thị" [địa-chỉ-worker]');
    console.log("      user chỉ gồm a-z, 0-9, dấu gạch ngang (2-32 ký tự), vd: nam");
    process.exit(1);
  }
  const displayName = rest[0]?.trim() || name;
  const workerUrl = (rest[1] || DEFAULT_WORKER_URL).replace(/\/+$/, "");
  const secret = `owes_${randomBytes(24).toString("hex")}`;
  const existed = spawnSync(
    "npx",
    ["wrangler", "kv", "key", "get", `tenant:${name}`, "--namespace-id", namespaceId, "--remote"],
    { cwd: WORKER_DIR, encoding: "utf8", shell: process.platform === "win32" }
  );
  if (existed.status === 0) {
    console.log(`⚠️  Phòng "${name}" đã tồn tại — chạy lại sẽ GHI ĐÈ mật khẩu cũ (thiết bị cũ vẫn hoạt động).`);
    console.log("   Muốn xóa hẳn: node scripts/tenant.mjs revoke " + name);
    process.exit(1);
  }
  kv(
    "put",
    `tenant:${name}`,
    JSON.stringify({ secret, name: displayName, createdAt: Date.now() })
  );
  console.log("");
  console.log("=================================================================");
  console.log(` THẺ MỜI — phòng "${name}" (${displayName})`);
  console.log("=================================================================");
  console.log(` Tên đăng nhập : ${name}`);
  console.log(` Mật khẩu      : ${secret}`);
  console.log("-----------------------------------------------------------------");
  console.log(` Gửi kèm 2 bước này cho bạn ấy (web: ${workerUrl}):`);
  console.log("");
  console.log(" BƯỚC 1 — trên MÁY TÍNH của bạn ấy (terminal bridge):");
  console.log(`   openpocket edge join ${workerUrl}`);
  console.log("   → nhập tên đăng nhập + mật khẩu ở trên (1 lần, lưu luôn)");
  console.log("");
  console.log(" BƯỚC 2 — trên ĐIỆN THOẠI của bạn ấy:");
  console.log(`   mở ${workerUrl}`);
  console.log('   → tab "Đăng nhập" → nhập CÙNG cặp trên (1 lần, lưu luôn)');
  console.log("");
  console.log(" Lưu ý: làm BƯỚC 1 TRƯỚC — máy phải đang chạy bridge mới đăng nhập được.");
  console.log("=================================================================");
  process.exit(0);
}

if (action === "list") {
  const out = kv("list", "--prefix", "tenant:");
  const keys = JSON.parse(out || "[]").map((k) => String(k.name ?? ""));
  if (!keys.length) {
    console.log("Chưa có phòng nào. Tạo: node scripts/tenant.mjs add <user> \"Tên\"");
    process.exit(0);
  }
  console.log(`Có ${keys.length} phòng:`);
  for (const key of keys) {
    const id = key.slice("tenant:".length);
    try {
      const record = JSON.parse(kv("get", key) || "{}");
      console.log(`  ${id}  —  ${record.name ?? "?"}  (tạo ${new Date(record.createdAt ?? 0).toLocaleString("vi-VN")})`);
    } catch {
      console.log(`  ${id}  —  (không đọc được chi tiết)`);
    }
  }
  process.exit(0);
}

if (action === "revoke") {
  const name = String(user ?? "").toLowerCase();
  if (!TENANT_RE.test(name)) {
    console.log("Dùng: node scripts/tenant.mjs revoke <user>");
    process.exit(1);
  }
  kv("delete", `tenant:${name}`);
  try {
    kv("delete", `machine:${name}`);
  } catch {}
  console.log(`🗑️  Đã xóa phòng "${name}" — máy của phòng này sẽ hết chỗ đăng ký, ai đang giữ khóa cũng không nối được nữa.`);
  process.exit(0);
}

console.log("openpocket tenant manager — quản lý phòng multi-tenant trên KV");
console.log('Dùng: node scripts/tenant.mjs add <user> "Tên hiển thị" [địa-chỉ-worker]');
console.log("      node scripts/tenant.mjs list");
console.log("      node scripts/tenant.mjs revoke <user>");
process.exit(1);
