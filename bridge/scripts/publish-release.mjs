// Publish bản bridge mới lên worker (KV OWM_STATE) cho OTA tự cập nhật từ xa.
// Cách dùng (chạy trên máy DEV, có wrangler đã login):
//   node bridge/scripts/publish-release.mjs                 # tự bump version
//   node bridge/scripts/publish-release.mjs 2026.09.16.1    # version cụ thể
//
// Làm gì: đọc toàn bộ bridge/src + package.json + VERSION, băm base64 vào một
// payload JSON, tính sha256 của payload đó, ghi 2 key KV:
//   bridge-release:latest = {version, sha256}  (manifest rẻ cho bridge check)
//   bridge-release:files  = {version, files:{...}}  (payload nặng, chỉ tải khi cần)
//
// KHÔNG đụng node_modules / config.json / .ota-* — bản cập nhật chỉ là code.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const here = dirname(fileURLToPath(import.meta.url));
const bridgeRoot = resolve(here, "..");
const workerRoot = resolve(bridgeRoot, "..", "worker");
const SRC = join(bridgeRoot, "src");
const VERSION_FILE = join(bridgeRoot, "VERSION");
const PUBLISH_DIR = join(workerRoot, "ota-publish"); // dọn sau khi push

function currentVersion() {
  try {
    return readFileSync(VERSION_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function nextVersion(custom) {
  if (custom) return custom;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  // <ngày>.<giờ-phút> khác nhau mỗi lần publish → luôn tăng theo thời gian.
  return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Đọc đệ quy một thư mục → map "tên tương đối" → Buffer. */
function collectDir(dir, prefix, out) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) {
      collectDir(full, rel, out);
    } else {
      out[rel] = readFileSync(full);
    }
  }
  return out;
}

const version = nextVersion(process.argv[2]);
const files = {};
collectDir(SRC, "src", files);
// Không đóng gói file độc quyền theo máy — chỉ cần index.js + toàn bộ src.
files["package.json"] = readFileSync(join(bridgeRoot, "package.json"));
if (existsSync(VERSION_FILE)) files["VERSION"] = readFileSync(VERSION_FILE);
else files["VERSION"] = Buffer.from(version);

const payload = { version, files: {} };
for (const [rel, buf] of Object.entries(files)) payload.files[rel] = buf.toString("base64");
const payloadText = JSON.stringify(payload);
const sha256 = createHash("sha256").update(payloadText).digest("hex");
const manifest = { version, sha256, publishedAt: new Date().toISOString() };

mkDir(PUBLISH_DIR);
writeFileSync(join(PUBLISH_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(join(PUBLISH_DIR, "files.json"), payloadText);

// Push 2 key KV qua wrangler CLI của dự án (chạy trong worker/ để trỏ đúng
// wrangler.jsonc + binding OWM_STATE). Nếu lệnh lỗi, payload vẫn nằm ở
// worker/ota-publish/ để user tự xem.
function runWrangler(args) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return execFileSync(npx, args, { cwd: workerRoot, stdio: "inherit" });
}

try {
  runWrangler([
    "wrangler", "kv", "key", "put", "--binding=OWM_STATE",
    "bridge-release:latest", "--path", join(PUBLISH_DIR, "manifest.json"),
  ]);
  runWrangler([
    "wrangler", "kv", "key", "put", "--binding=OWM_STATE",
    "bridge-release:files", "--path", join(PUBLISH_DIR, "files.json"),
  ]);
  rmSync(PUBLISH_DIR, { recursive: true, force: true });
  console.log(`\n[ota] ĐÃ publish bridge v${version} (sha256 ${sha256.slice(0, 12)}...).`);
  console.log("[ota] Bản máy bạn bè sẽ tự nhận trong lần check kế (≤6h) — hoặc restart bridge để nó check ngay.");
} catch (e) {
  console.error(`\n[ota] PUSH KV LỖI: ${e.message}`);
  console.error(`[ota] Payload để sẵn tại ${PUBLISH_DIR}/ — tự chạy wrangler kv key put --binding=OWM_STATE "bridge-release:<latest|files>" --path <file> trong worker/.`);
  process.exitCode = 1;
}

function mkDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}