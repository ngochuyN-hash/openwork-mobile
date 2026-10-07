// Định danh máy — MỘT module duy nhất nắm luật: whitelist key, làm sạch giá
// trị, ghi config, log. Trước 07/10 luật này sống ở 2 route riêng
// (/api/machine/name trong routes/status.js và /api/config/identity trong
// routes/config.js), mỗi nơi một bản copy phép sanitize — sửa luật là phải nhớ
// sửa cả 2 nơi + 3 test pin độc lập. Giờ 2 route chỉ còn là adapter mỏng gọi
// module này (candidate 1 của review 07/10).
//
// Whitelist nằm ở shared/identity-keys.txt — NGUỒN DUY NHẤT, cũng chính là
// nơi desktop/build.bat sinh src/IdentityKeys.cs cho GUI C# (candidate 2):
// bridge và GUI không thể trôi khỏi nhau vì cùng đọc một file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { saveConfig } from "./config.js";

const IDENTITY_KEYS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../shared/identity-keys.txt"
);

// machineName là tên hiển thị: bóc ký tự xuống dòng/nháy, trần 60. Các key còn
// lại là URL/tenant/secret: trim + trần 300 (luật cũ của /api/config/identity).
const MAX_VALUE_LENGTH = 300;

export function sanitizeMachineName(raw) {
  return String(raw ?? "").replace(/[\r\n"']/g, "").trim().slice(0, 60);
}

/** Đọc whitelist từ nguồn chung. Đọc hỏng (file thiếu) trả mảng rỗng: route
 * còn sống nhưng từ chối mọi đổi identity (400 no_valid_keys) — an toàn hơn
 * đoán mò key. */
export function loadIdentityKeys() {
  try {
    return readFileSync(IDENTITY_KEYS_FILE, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Áp một patch định danh máy vào config: chỉ nhận key nằm trong whitelist và
 * có giá trị string, làm sạch theo luật từng key, ghi config.json NGAY khi có
 * ít nhất 1 key được áp. Log chỉ ghi TÊN key — lookupSecret là mật khẩu phòng,
 * không bao giờ lọt vào log. Trả về mảng key đã áp; caller tự quyết định lỗi
 * khi mảng rỗng (machine/name → invalid_name, config/identity → no_valid_keys).
 */
export function applyIdentity(config, patch) {
  const whitelist = new Set(loadIdentityKeys());
  const applied = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!whitelist.has(key) || typeof value !== "string") continue;
    config[key] =
      key === "machineName" ? sanitizeMachineName(value) : value.trim().slice(0, MAX_VALUE_LENGTH);
    applied.push(key);
  }
  if (applied.length > 0) {
    saveConfig(config);
    console.log(`[bridge] machine identity updated: ${applied.join(", ")}`);
  }
  return applied;
}
