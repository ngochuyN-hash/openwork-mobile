import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
//
// Chống 429 (13/09): đi http2/IPv4 thay QUIC/UDP (nguồn chết hầm) + backoff
// GHI FILE (tunnel-state.json) nên restart bridge không xoá nổi sự kiên nhẫn.

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const DOWNLOAD_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

// cloudflared mặc định đi QUIC qua UDP:7844 — mạng nhà (VN) hay rớt UDP tới
// edge (log: "datagram manager error: timeout: no recent network activity",
// "wsasendto ... failed") khiến tunnel chết liên tục, mà mỗi lần chết là một
// yêu cầu TẠO tunnel mới — chính chuỗi chết này đẻ ra 429. Ép http2 (TCP/443)
// + edge IPv4: ít chết hẳn, hết nguồn nuôi limit.
const SPAWN_FLAGS = ["--protocol", "http2", "--edge-ip-version", "4"];

// Bộ đếm kiên nhẫn 429 nằm TRONG FILE chứ không trong RAM: trước đây restart
// bridge (nút Restart của GUI, task, session song song) là xoá sạch backoff,
// tiến trình mới gõ cửa 429 ngay từ giây đầu — limit Cloudflare đếm theo IP,
// không quan tâm tiến trình nào gõ, nên cứ restart là tự gia hạn mãi.
export function tunnelStateFile() {
  return join(bridgeDataDir(), "tunnel-state.json");
}
export function loadTunnelState() {
  try {
    const s = JSON.parse(readFileSync(tunnelStateFile(), "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}
export function saveTunnelState(state) {
  try {
    writeFileSync(tunnelStateFile(), JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2) + "\n");
  } catch {}
}
// Độ chờ khi dính 429: streak 1 = 2 phút, nhân đôi mỗi lần, trần 10 phút.
export function rateLimitDelayMs(streak) {
  return Math.min(120_000 * 2 ** Math.max(0, streak - 1), 600_000);
}
// Độ chờ thử lại thường (không phải 429): 5s nhân đôi, trần 60s.
export function plainRetryDelayMs(attempt) {
  return Math.min(5000 * 2 ** Math.max(0, attempt - 1), 60_000);
}

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
  let phase = "starting"; // "starting" | "up" | "backoff" — cho CLI/GUI/heartbeat đọc
  let nextRetryAt = 0; // mốc thời gian lần thử tiếp theo khi đang backoff
  let currentChild = null; // cloudflared đang sống — restart thủ công phải giết ĐÚNG con này
  let pendingRetryTimer = null; // hẹn chạy lại đang treo — restart phải huỷ trước khi tự chạy
  let suppressExit = false; // exit sắp firing là do mình kill để restart, đừng xếp lịch lại
  let restarting = false; // khoá re-entrancy: 1 restart đang đi thì bấm nữa bỏ qua

  // Nhặt lại bộ đếm từ lần chạy trước: bridge vừa restart cũng KHÔNG được gõ
  // cửa 429 sớm hơn mức đã hẹn — limit đếm theo IP, không quan tâm tiến trình.
  const persisted = loadTunnelState();
  if (persisted?.phase === "backoff" && Number.isInteger(persisted.streak)) {
    rateLimitStreak = Math.max(1, persisted.streak);
  }
  const getState = () => ({ phase, url: currentUrl, streak: rateLimitStreak, nextRetryAt });

  const runOnce = async () => {
    attempt += 1;
    phase = "starting";
    log(`[tunnel] chạy cloudflared (đợt ${attempt})...`);
    let sawRateLimit = false;

    // Mỗi đợt chạy chỉ được hẹn đúng MỘT lần chạy lại: exit và error cùng firing
    // thì cái nào tới trước thắng, kẻo hai vòng hẹn nhau rồi dội tunnel không nghỉ.
    let respawnScheduled = false;
    const scheduleRetry = (delay, reason) => {
      if (respawnScheduled || stopped) return;
      respawnScheduled = true;
      log(`[tunnel] ${reason} - chờ ${Math.round(delay / 1000)}s...`);
      pendingRetryTimer = setTimeout(() => {
        pendingRetryTimer = null;
        if (!stopped) runOnce().catch((e) => log(`[tunnel] lỗi: ${e.message}`));
      }, delay);
    };

    const child = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${targetPort}`, ...SPAWN_FLAGS, "--no-autoupdate"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    currentChild = child;
    suppressExit = false;
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
        phase = "up";
        nextRetryAt = 0;
        saveTunnelState({ phase: "up", url: currentUrl, streak: 0, nextAttemptAt: 0 });
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
      // suppressExit = chính mình vừa kill để restart; child !== currentChild =
      // con của đợt cũ chết trễ sau khi đợt mới đã lên — cả hai đừng xếp lịch
      // thêm, kẻo hai cloudflared cùng sống là xin hai tunnel tự nuôi limit.
      if (stopped || suppressExit || child !== currentChild) return;
      // 429/1015 = Cloudflare rate-limit quick tunnel theo IP: chờ lâu dần
      // (2ph → 4ph → ... tối đa 10ph) thay vì dội 5s/lần làm limit kéo dài thêm.
      // Code -1 (4294967295, Windows) = bị edge dump sau khi cấp URL hoặc bị giết
      // ngoài — khi IP đang bị 1015 thì cũng phải chờ dài, không là dội 60s/lần
      // tự nuôi tiếp limit (vicious loop đêm 13/09).
      const dumped = code === 4294967295 || code === -1;
      if (sawRateLimit || code === 1 || dumped) {
        rateLimitStreak = sawRateLimit || dumped ? rateLimitStreak + 1 : 0;
      }
      if (rateLimitStreak > 0) {
        const delay = rateLimitDelayMs(rateLimitStreak);
        nextRetryAt = Date.now() + delay;
        phase = "backoff";
        saveTunnelState({ phase: "backoff", url: "", streak: rateLimitStreak, nextAttemptAt: nextRetryAt });
        scheduleRetry(delay, "Cloudflare đang giới hạn tạo tunnel (429)");
      } else {
        scheduleRetry(plainRetryDelayMs(attempt), `cloudflared thoát (code ${code}) - chạy lại`);
      }
    });
  };

  // Lần chạy đầu: nếu state lần trước còn hẹn (429 chưa hết), đợi ĐÚNG hẹn đó
  // rồi mới gõ cửa — spawn ngay là đẻ thêm 429, tự gia hạn limit.
  const bootWait =
    persisted?.phase === "backoff" ? Math.max(0, Number(persisted.nextAttemptAt || 0) - Date.now()) : 0;
  if (bootWait > 0) {
    phase = "backoff";
    nextRetryAt = Date.now() + bootWait;
    log(
      `[tunnel] lần trước còn dính 429 (streak ${rateLimitStreak}) — chờ ${Math.round(
        bootWait / 1000
      )}s nữa mới thử lại (không gõ cửa sớm)...`
    );
  }
  setTimeout(() => {
    if (!stopped) runOnce().catch((error) => log(`[tunnel] không khởi động được: ${error.message}`));
  }, bootWait);

  return {
    get url() {
      return currentUrl;
    },
    getState,
    // Restart THỦ CÔNG (nút "Restart tunnel" GUI / POST /api/tunnel/restart):
    // bỏ qua bộ đếm backoff — bộ đếm nhiều khi hên xui vì nó đếm theo TỪNG LẦN
    // 429 trong file, không biết IP đã đổi (restart router) hay limit đã hết
    // hạn. Người dùng chủ động = cho gõ cửa NGAY; Cloudflare vẫn còn limit thì
    // dính 429 và backoff tự chạy lại như cũ, không hư gì.
    restart() {
      if (stopped || restarting) return false;
      restarting = true;
      log("[tunnel] restart thủ công — bỏ bộ đếm chờ, xin tunnel mới ngay...");
      if (pendingRetryTimer) {
        clearTimeout(pendingRetryTimer);
        pendingRetryTimer = null;
      }
      attempt = 0;
      rateLimitStreak = 0;
      nextRetryAt = 0;
      phase = "starting";
      saveTunnelState({ phase: "starting", url: "", streak: 0, nextAttemptAt: 0 });
      const child = currentChild;
      const go = () => {
        if (!restarting) return; // exit thật + fallback timeout cùng firing — cái trước thắng
        restarting = false;
        if (stopped) return;
        runOnce().catch((error) => log(`[tunnel] lỗi restart: ${error.message}`));
      };
      if (child && child.exitCode === null) {
        // Con cũ còn sống: giết rồi đợi nó chết hẳn mới chạy lại — hai
        // cloudflared cùng lúc là xin hai tunnel, tự nuôi thêm limit.
        suppressExit = true;
        child.once("exit", go);
        try {
          child.kill();
        } catch {}
        // kill cứng hiếm khi không phát exit — 3s vẫn phải đi tiếp
        setTimeout(go, 3000);
      } else {
        go();
      }
      return true;
    },
    stop() {
      stopped = true;
    },
  };
}
