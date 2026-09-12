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
import { existsSync, readFileSync } from "node:fs";
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

// Gọi wrangler TRỰC TIẾP bằng node (không qua shell): spawnSync("npx", …, shell:true)
// trên Windows để cmd nuốt mất dấu nháy của giá trị JSON — KV từng lưu
// `{secret:…}` không còn là JSON hợp lệ và worker đọc không ra secret.
let wranglerJs = join(WORKER_DIR, "..", "web", "node_modules", "wrangler", "bin", "wrangler.js");
if (!existsSync(wranglerJs)) {
  wranglerJs = "npx"; // dự phòng: cài wrangler toàn cục / PATH
}
function wranglerCmd(...args) {
  const base = wranglerJs === "npx" ? ["wrangler"] : [wranglerJs];
  return spawnSync(
    wranglerJs === "npx" ? "npx" : process.execPath,
    [...base, "kv", "key", ...args, "--namespace-id", namespaceId, "--remote"],
    { cwd: WORKER_DIR, encoding: "utf8", shell: false }
  );
}
function kv(...args) {
  const result = wranglerCmd(...args);
  if (result.status !== 0) {
    console.error(result.stdout || "");
    console.error(result.stderr || "wrangler thất bại");
    process.exit(1);
  }
  return result.stdout;
}

// get dùng cho kiểm tra tồn tại: 404 (chưa có phòng) là chuyện bình thường
function kvSoft(...args) {
  const result = wranglerCmd(...args);
  return result.status === 0 ? result.stdout : null;
}

// Đưa text vào clipboard (best-effort — fail im lặng, user tự copy tay)
function copyToClipboard(text) {
  const cmds = { win32: ["clip"], darwin: ["pbcopy"], linux: ["wl-copy"] };
  const cmd = cmds[process.platform];
  if (!cmd) return false;
  try {
    return spawnSync(cmd[0], [], { input: text, shell: false }).status === 0;
  } catch {
    return false;
  }
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
  const existing = kvSoft("get", `tenant:${name}`);
  if (existing !== null && String(existing).trim().startsWith("{")) {
    console.log(`⚠️  Phòng "${name}" đã tồn tại — chạy lại sẽ GHI ĐÈ mật khẩu cũ (thiết bị cũ vẫn hoạt động).`);
    console.log("   Muốn xóa hẳn: node scripts/tenant.mjs revoke " + name);
    process.exit(1);
  }
  kv(
    "put",
    `tenant:${name}`,
    JSON.stringify({ secret, name: displayName, createdAt: Date.now() })
  );
  // Link mời: điện thoại bấm là tự đăng nhập (web bắt #i=), máy tính dán vào
  // `openpocket edge join <link>` cũng đọc được user/pass ngay trong link.
  const inviteLink = `${workerUrl}/#i=${name}:${secret}`;
  const invite = [
    "=================================================================",
    ` THẺ MỜI — phòng "${name}" (${displayName})`,
    "=================================================================",
    ` Tên đăng nhập : ${name}`,
    ` Mật khẩu      : ${secret}`,
    "-----------------------------------------------------------------",
    " 🔗 LINK MỜI — gửi cho bạn ấy (chat riêng vì có chứa mật khẩu):",
    `   ${inviteLink}`,
    "-----------------------------------------------------------------",
    " Bạn ấy chỉ cần:",
    " BƯỚC 1 — MÁY TÍNH (cài bridge xong, bridge đang chạy):",
    "   openpocket edge join <dán nguyên link ở trên>",
    " BƯỚC 2 — ĐIỆN THOẠI: bấm link → tự vào app luôn, không gõ gì.",
    "",
    " (Cách gõ tay dự phòng: mở web → tab Đăng nhập → nhập user/pass trên)",
    " Lưu ý: làm BƯỚC 1 TRƯỚC — máy phải đang chạy bridge mới đăng nhập được.",
    "=================================================================",
  ].join("\n");
  console.log("");
  console.log(invite);
  if (copyToClipboard(invite + "\n")) {
    console.log("📋 Đã copy thẻ mời vào clipboard — dán (Ctrl+V) gửi bạn qua Zalo/Messenger là xong.");
  } else {
    console.log("ℹ️  Tự copy bằng tay: quét khối thẻ mời ở trên rồi Ctrl+C.");
  }
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
