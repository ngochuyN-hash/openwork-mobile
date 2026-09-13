import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bridgeDataDir } from "./config.js";

// Auto Cloudflare Quick Tunnel (học từ 9Remote): bridge tự tải cloudflared,
// tự chạy tunnel ra internet, tự dò URL trycloudflare.com từ log, tự khởi động
// lại khi cloudflared chết và tự báo URL mới về cho index.js (in QR lại).
//
// Giới hạn của Quick Tunnel (bản chất của Cloudflare, không tránh được):
//   - URL ĐỔI mỗi lần tiến trình cloudflared khởi động lại
//   - Không có SLA - dùng cá nhân thì giữ process là ổn
// Muốn URL cố định vĩnh viễn: named tunnel + domain (xem README).

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const DOWNLOAD_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

export function cloudflaredPath() {
  return join(bridgeDataDir(), process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
}

async function ensureCloudflared(log) {
  const target = cloudflaredPath();
  if (existsSync(target)) return target;
  // Có sẵn trên PATH thì dùng luôn
  const fromPath = await new Promise((resolve) => {
    const probe = spawn(process.platform === "win32" ? "where" : "which", ["cloudflared"]);
    let out = "";
    probe.stdout.on("data", (d) => (out += d));
    probe.on("close", (code) => resolve(code === 0 ? out.split(/\r?\n/)[0].trim() : ""));
    probe.on("error", () => resolve(""));
  });
  if (fromPath) return fromPath;

  log(`[tunnel] tải cloudflared về ${target} (chỉ lần đầu, ~50MB)...`);
  const response = await fetch(DOWNLOAD_URL, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Tải cloudflared lỗi: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const { writeFileSync } = await import("node:fs");
  writeFileSync(target, buffer);
  if (process.platform !== "win32") {
    const { chmodSync } = await import("node:fs");
    chmodSync(target, 0o755);
  }
  return target;
}

/**
 * Chạy quick tunnel trỏ vào port cục bộ. Trả về controller.
 * @param {number} targetPort port của bridge (127.0.0.1)
 * @param {{onUrl:(url:string)=>void, log?:console.log}} handlers
 */
export async function startQuickTunnel(targetPort, { onUrl, log = console.log } = {}) {
  const bin = await ensureCloudflared(log);
  let stopped = false;
  let currentUrl = "";
  let attempt = 0; // số lần chạy lại liên tục (reset khi có URL mới)
  let rateLimitStreak = 0; // số lần dính 429 liên tiếp

  const runOnce = async () => {
    attempt += 1;
    log(`[tunnel] chạy cloudflared (đợt ${attempt})...`);
    let sawRateLimit = false;

    // Mỗi đợt chạy chỉ được hẹn đúng MỘT lần chạy lại: exit và error cùng firing
    // thì cái nào tới trước thắng, kẻo hai vòng hẹn nhau rồi dội tunnel không nghỉ.
    let respawnScheduled = false;
    const scheduleRetry = (delay, reason) => {
      if (respawnScheduled || stopped) return;
      respawnScheduled = true;
      log(`[tunnel] ${reason} - chờ ${Math.round(delay / 1000)}s...`);
      setTimeout(() => {
        if (!stopped) runOnce().catch((e) => log(`[tunnel] lỗi: ${e.message}`));
      }, delay);
    };

    const child = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${targetPort}`, "--no-autoupdate"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // spawn hụt (exe bị khoá/ENOENT...) KHÔNG phát exit — không bắt error thì
    // vòng retry lặng lẽ chết, bridge tưởng còn tunnel mãi (bệnh đêm 13/09:
    // im re hơn 2 tiếng không một dòng log, worker báo bridge_offline).
    child.on("error", (err) => scheduleRetry(60_000, `lỗi spawn cloudflared: ${err.message}`));

    let announced = false;
    const scan = (chunk) => {
      const text = chunk.toString();
      const match = text.match(TUNNEL_URL_RE);
      if (match && match[0] !== currentUrl) {
        currentUrl = match[0];
        announced = true;
        attempt = 0;
        rateLimitStreak = 0;
        onUrl(currentUrl);
      }
      if (/status 429|error code: 1015/i.test(text)) sawRateLimit = true;
      // log ngắn gọn lỗi đáng chú ý (ignore INFO ồn ào)
      for (const line of text.split(/\r?\n/)) {
        if (/\bERR\b/.test(line)) log(`[tunnel] ${line.trim().slice(0, 160)}`);
      }
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);

    child.on("exit", async (code) => {
      if (stopped) return;
      // 429/1015 = Cloudflare rate-limit quick tunnel theo IP: chờ lâu dần
      // (2ph → 4ph → ... tối đa 10ph) thay vì dội 5s/lần làm limit kéo dài thêm.
      // Code -1 (4294967295, Windows) = bị edge dump sau khi cấp URL hoặc bị giết
      // ngoài — khi IP đang bị 1015 thì cũng phải chờ dài, không là dội 60s/lần
      // tự nuôi tiếp limit (vicious loop đêm 13/09).
      const dumped = code === 4294967295 || code === -1;
      if (sawRateLimit || code === 1 || dumped) {
        rateLimitStreak = sawRateLimit || dumped ? rateLimitStreak + 1 : 0;
      }
      let delay = Math.min(5000 * 2 ** Math.max(0, attempt - 1), 60_000);
      if (rateLimitStreak > 0) {
        delay = Math.min(120_000 * 2 ** (rateLimitStreak - 1), 600_000);
        scheduleRetry(delay, "Cloudflare đang giới hạn tạo tunnel (429)");
      } else {
        scheduleRetry(delay, `cloudflared thoát (code ${code}) - chạy lại`);
      }
    });
  };

  await runOnce().catch((error) => {
    log(`[tunnel] không khởi động được: ${error.message}`);
  });

  return {
    get url() {
      return currentUrl;
    },
    stop() {
      stopped = true;
    },
  };
}
