import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Bridge runtime config lives OUTSIDE the repo (it holds secrets):
//   Windows: %APPDATA%\openwork-bridge\config.json
//   Others:  ~/.openwork-bridge/config.json
// Override with OPENWORK_BRIDGE_DIR.
export function bridgeDataDir() {
  const override = (process.env.OPENWORK_BRIDGE_DIR || "").trim();
  if (override) return override;
  const appData = process.env.APPDATA;
  if (appData) return join(appData, "openwork-bridge");
  return join(homedir(), ".openwork-bridge");
}

const CONFIG_FILE = "config.json";

export function loadConfig() {
  const dir = bridgeDataDir();
  const file = join(dir, CONFIG_FILE);
  let parsed = {};
  if (existsSync(file)) {
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // Corrupt config: fall through to defaults and rewrite below.
      parsed = {};
    }
  }
  const config = {
    // Token the PHONE presents to the bridge (never leaves this machine + the phone).
    mobileToken: typeof parsed.mobileToken === "string" && parsed.mobileToken ? parsed.mobileToken : `owm_${randomBytes(24).toString("hex")}`,
    // Owner token we mint into OpenWork's tokens.json (empty until bootstrapped).
    ownerToken: typeof parsed.ownerToken === "string" ? parsed.ownerToken : "",
    // Port of the bridge HTTP server (binds 127.0.0.1 only).
    port: Number.isInteger(parsed.port) && parsed.port > 0 ? parsed.port : 8788,
    // Last known openwork-server port, to probe first on next start.
    lastServerPort: Number.isInteger(parsed.lastServerPort) && parsed.lastServerPort > 0 ? parsed.lastServerPort : 0,
    // Optional public URL (tailscale serve) — used for the pairing QR.
    publicUrl: typeof parsed.publicUrl === "string" ? parsed.publicUrl : "",
    // Cloudflare Worker "địa chỉ cố định" (worker/ trong dự án) — bridge heartbeat
    // địa chỉ tunnel hiện tại lên đó để điện thoại luôn tìm được máy.
    lookupUrl: typeof parsed.lookupUrl === "string" ? parsed.lookupUrl : "",
    lookupSecret: typeof parsed.lookupSecret === "string" ? parsed.lookupSecret : "",
    // Đường dẫn file .exe OpenWork desktop (trống = tự tìm ở chỗ hay gặp).
    // Override bằng env OPENWORK_EXE. Dùng cho "bật OpenWork từ điện thoại".
    openworkExe: typeof parsed.openworkExe === "string" ? parsed.openworkExe : "",
    // true = mỗi lần bridge khởi động mà chưa thấy server thì tự mở OpenWork.
    // Bật bằng: openpocket autostart --enable --with-openwork
    autoLaunchOpenWork: parsed.autoLaunchOpenWork === true,
    ...parsed,
  };
  return config;
}

export function saveConfig(config) {
  const dir = bridgeDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, CONFIG_FILE);
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
  return file;
}
