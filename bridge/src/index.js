import { readFileSync, watch, writeFileSync, unlinkSync } from "node:fs";
import qrcode from "./vendor/qrcode-terminal/index.js";
import { loadConfig, saveConfig, bridgeDataDir, pairingBaseUrl } from "./config.js";
import { ensureOwnerToken } from "./bootstrap.js";
import { discoverServer, checkTokenActive, probeServerUrl } from "./discovery.js";
import { openworkFilePath } from "./paths.js";
import { startQuickTunnel } from "./tunnel.js";
import { startLookup } from "./lookup.js";
import { PairingService, CODE_TTL_MINUTES } from "./pairing.js";
import { launchOpenWork } from "./openwork-launch.js";
import { rotateStaleLogs, scheduleDailyWipe, wipeLogs } from "./logwipe.js";
import { redactUrl, redactSecrets } from "./log-safe.js";
import { createApp } from "./app.js";
import { startRateLimitSweep } from "./rate-limit.js";
import { createStaticHandler } from "./static.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildPairingUrl } from "../../shared/contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Single version source of truth: bridge/package.json (the OTA VERSION file is gone).
const BRIDGE_VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version;

const config = loadConfig();

// ---------------------------------------------------------------------------
// 1. Bootstrap the owner token into OpenWork's tokens.json (one-time; needs a
//    single OpenWork restart to take effect).
// ---------------------------------------------------------------------------
const boot = ensureOwnerToken(config.ownerToken);
config.ownerToken = boot.token;
if (process.env.OPENWORK_PUBLIC_URL) config.publicUrl = process.env.OPENWORK_PUBLIC_URL.trim().replace(/\/+$/, "");
saveConfig(config);

// Log chỉ sống tối đa 1 ngày (owner 13/09): sót từ hôm trước thì dọn NGAY
// trước khi in banner, rồi hẹn nửa đêm dọn tiếp.
rotateStaleLogs();
scheduleDailyWipe();

// ---------------------------------------------------------------------------
// 2. Runtime state: where is openwork-server, is our token live?
// ---------------------------------------------------------------------------
const state = {
  server: null, // {baseUrl, version, opencodeVersion, uptimeMs}
  tokenActive: false,
  restartRequired: boot.restartRequired,
  lastCheckAt: 0,
  tunnelUrl: "", // URL trycloudflare.com hiện tại (đổi mỗi lần cloudflared chạy lại)
};
// Trạng thái đường hầm cho /api/state + heartbeat lookup đọc. `getState`/`restart`
// là ô ghi trống: index.js thay chúng bằng controller thật ngay khi
// startQuickTunnel chạy xong bên dưới (xem onListening).
const tunnel = {
  getState: () => ({ phase: "starting", url: "", streak: 0, nextRetryAt: 0 }),
  // Restart thủ công — false = tunnel không chạy (OPENWORK_BRIDGE_TUNNEL=0 / chưa lên)
  restart: () => false,
};
let tunnelController = null;

// ---------------------------------------------------------------------------
// 1.5 Pairing kiểu 9Remote: mã one-time 30 phút trong QR + khóa thiết bị vĩnh viễn
// ---------------------------------------------------------------------------
const pairing = new PairingService();

// Base URL printed into pairing QRs: PREFER the worker (the fixed address) —
// the tunnel URL changes on every cloudflared restart, so a phone holding an
// old QR would miss. ONLY when the machine actually has a room, though: a
// roomless link via the worker is refused at the door (400 tenant_required),
// so a machine without a room must point its QR straight at the
// tunnel/public URL instead (pairingBaseUrl, unit-tested).
const currentBase = () => pairingBaseUrl(config, state.tunnelUrl, config.publicUrl, config.port);
// Link ghép nối gắn phòng để web tự điền: hình dạng (#p=...&m= / #t=...&m=)
// do shared/contract.js định nghĩa một chỗ duy nhất (buildPairingUrl).
let printingPairing = false;
pairing.onCode = () => {
  // Mã mới (thiết bị vừa ghép xong hoặc mã cũ hết hạn) -> in lại QR
  if (!printingPairing) printPairing(currentBase(), "[pairing] NEW pairing code:");
};

async function refreshDiscovery({ force = false } = {}) {
  if (force) state.server = null;
  if (!state.server) {
    const found = await discoverServer({ lastServerPort: config.lastServerPort });
    if (found) {
      state.server = found;
      if (new URL(found.baseUrl).port !== String(config.lastServerPort)) {
        config.lastServerPort = Number(new URL(found.baseUrl).port) || 0;
        saveConfig(config);
      }
      console.log(`[bridge] openwork-server found at ${redactUrl(found.baseUrl)} (v${found.version}, opencode ${found.opencodeVersion})`);
    }
  }
  if (state.server && !state.tokenActive) {
    state.tokenActive = await checkTokenActive(state.server.baseUrl, config.ownerToken);
    state.lastCheckAt = Date.now();
    if (state.tokenActive && state.restartRequired) {
      state.restartRequired = false;
      console.log("[bridge] owner token is now ACTIVE - full access granted.");
    }
  }
}

// Poll loop: re-find the server when it moves or goes away, watch for the
// one-time OpenWork restart to activate our token.
setInterval(
  () => {
    (async () => {
      if (state.server) {
        const alive = await probeServerUrl(state.server.baseUrl).catch(() => null);
        if (!alive) {
          console.log("[bridge] openwork-server went away - rediscovering...");
          state.server = null;
          state.tokenActive = false;
        }
      }
      await refreshDiscovery();
    })().catch(() => {});
  },
  5_000
).unref();

// Watch engine-instances.json: OpenWork restart changes the port quickly.
try {
  watch(openworkDataDirForWatch(), { persistent: false }, (_event, filename) => {
    if (filename && !String(filename).includes("engine-instances")) return;
    setTimeout(() => refreshDiscovery().catch(() => {}), 1_000);
  });
} catch {
  // directory may not exist yet; the poll loop covers us
}
function openworkDataDirForWatch() {
  // watch the directory, not the file - atomic rewrites would break a file watch
  return join(dirname(openworkFilePath("engine-instances.json")));
}

await refreshDiscovery();

// Tự mở OpenWork khi bridge khởi động (nếu user bật --with-openwork lúc cài
// autostart). Discovery loop 5s có sẵn sẽ tự bắt server khi app mở xong.
if (config.autoLaunchOpenWork && !state.server) {
  launchOpenWork({ configOpenworkExe: config.openworkExe }).catch((error) =>
    console.error(`[openwork] auto-launch at startup failed: ${redactSecrets(error.message)}`)
  );
}

if (state.restartRequired && !state.tokenActive) {
  console.log("");
  console.log("=================================================================");
  console.log(" IMPORTANT: OpenWork needs to be RESTARTED ONE TIME so that the");
  console.log(" bridge's owner token is loaded. Close OpenWork completely and");
  console.log(" open it again - the bridge will pick it up automatically.");
  console.log("=================================================================");
  console.log("");
}

// ---------------------------------------------------------------------------
// 3. HTTP server: the only surface exposed (127.0.0.1). The Cloudflare tunnel +
//    the openpocket worker front it for remote HTTPS access from the phone.
//    Bảng route + cổng khóa nằm ở app.js — index.js chỉ còn boot + listen.
// ---------------------------------------------------------------------------
const handleStatic = createStaticHandler(join(__dirname, "..", "..", "web", "dist"));

const { server, ctx } = createApp({
  config,
  state,
  pairing,
  bridgeVersion: BRIDGE_VERSION,
  handleStatic,
  refreshDiscovery,
  tunnel,
  getBaseUrl: currentBase,
});

// Rate-limit maps phình theo mọi IP từng thấy → quét mỗi 5 phút.
startRateLimitSweep([ctx.pairLimiter, ctx.wakeLimiter]);

// requestTimeout only bounds RECEIVING a request (measured: a completed GET
// stream survives far past requestTimeout=1s), so a finite value is safe for
// every response, SSE included. SSE sockets additionally get their idle
// timeout cleared per-request in handleRequest.
server.requestTimeout = 300_000; // slow headers/slowloris bodies stay bounded
server.headersTimeout = 60_000;

/**
 * In QR pairing ra terminal. Mặc định in mã one-time 30 phút (dùng 1 lần).
 * withMaster = true: in thêm QR master (token vĩnh viễn) — chỉ hiển thị trực tiếp
 * trên máy, KHÔNG chụp màn hình/chia sẻ vì có quyền vĩnh viễn.
 */
function printPairing(base, note, { withMaster = false } = {}) {
  if (!process.stdout.isTTY) return;
  printingPairing = true;
  const code = pairing.ensureCode();
  printingPairing = false;
  const pairingUrl = buildPairingUrl({ base, value: code, tenant: config.lookupTenant });
  console.log("");
  if (note) console.log(note);
  console.log(`  Device pairing QR (one-time code, expires after ${CODE_TTL_MINUTES} minutes):`);
  // Dòng URL để copy TAY thì in bản đã che (#p= chỉ còn 4 ký tự đầu) — link
  // dán tay là đường phụ, QR ngay dưới là đường chính và QR giữ nguyên mã thật.
  console.log(`  ${redactUrl(pairingUrl)}`);
  // Dòng này CỐ TÌNH giữ mã đầy đủ: nó là chỗ nhập tay trên điện thoại, mã
  // one-time sống 30 phút (CODE_TTL_MINUTES) nên không phải bí mật vĩnh viễn,
  // và chỉ in khi stdout là TTY (tức người chủ máy đang ngồi trước máy).
  console.log(`  Pairing code: ${code.slice(0, 4)}-${code.slice(4)}`);
  console.log("");
  qrcode.generate(pairingUrl, { small: true });
  if (withMaster) {
    const masterUrl = buildPairingUrl({ base, kind: "master", value: config.mobileToken, tenant: config.lookupTenant });
    console.log("  MASTER QR (permanent token - local machine only, NEVER share it):");
    // Mobile token vĩnh viễn -> dòng text phải che, QR giữ nguyên (chủ máy
    // quét bằng máy của mình, không ai đọc được log).
    console.log(`  ${redactUrl(masterUrl)}`);
    console.log("");
    qrcode.generate(masterUrl, { small: true });
  }
  console.log("");
}

const onListening = () => {
  const local = `http://127.0.0.1:${config.port}`;
  // Ghi pid NGAY TRONG bridge: mọi đường khởi động (task admin, openpocket
  // start, tay) đều hiện diện với `openpocket status/stop/ensure`. Trước đây
  // chỉ `openpocket start` ghi, instance từ task VBS là vô hình với CLI — hai
  // bên cùng start thì EADDRINUSE chồng nhau (sự cố sáng 13/09).
  try {
    writeFileSync(join(bridgeDataDir(), "bridge.pid"), String(process.pid));
  } catch {}
  console.log("");
  console.log(`OpenWork Mobile bridge v${BRIDGE_VERSION}`);
  console.log(`listening on ${local} (localhost only - remote access goes through the tunnel below)`);
  console.log(`openwork-server: ${state.server ? redactUrl(state.server.baseUrl) : "not found yet (waiting for OpenWork...)"}`);
  console.log(`token status: ${state.tokenActive ? "ACTIVE" : state.restartRequired ? "needs OpenWork restart (one time)" : "pending"}`);
  // QR thứ 1 (mã one-time 30 phút): để ghép thiết bị mới — hết hạn tự chết.
  // QR thứ 2 (master token): vĩnh viễn, chỉ in tại máy để chủ máy tiện tay
  // nhập thẳng trên điện thoại của mình — TUYỆT ĐỐI không chụp/chia sẻ.
  printPairing(config.publicUrl || local, "Open this link (or scan the QR) on your phone:", {
    withMaster: true,
  });

  // Auto Cloudflare Quick Tunnel: public URL miễn phí, không cần tài khoản.
  // URL đổi mỗi lần cloudflared chạy lại -> tự in QR mới. Tắt bằng OPENWORK_BRIDGE_TUNNEL=0
  if (process.env.OPENWORK_BRIDGE_TUNNEL !== "0") {
    startQuickTunnel(config.port, {
      onUrl: (url) => {
        state.tunnelUrl = url;
        // Tunnel URL là public — chỉ in QR mã one-time, KHÔNG in QR master.
        printPairing(currentBase(), "[tunnel] NEW public URL (works from 4G, no phone app needed):");
      },
    })
      .then((controller) => {
        tunnelController = controller;
        tunnel.getState = () => controller.getState();
        tunnel.restart = () => controller.restart();
      })
      .catch((error) => console.error(`[tunnel] error: ${redactSecrets(error.message)}`));
  }

  // Heartbeat lên Cloudflare Worker (địa chỉ cố định) nếu đã cấu hình:
  // điện thoại mở đúng 1 URL duy nhất, tự tìm được bridge dù tunnel đổi.
  if (config.lookupUrl && config.lookupSecret) {
    console.log(
      `[lookup] reporting to ${redactUrl(config.lookupUrl)}${config.lookupTenant ? ` (room: ${config.lookupTenant})` : ""}`
    );
    startLookup({
      getUrl: () => state.tunnelUrl,
      getState: () => tunnel.getState(),
      workerUrl: config.lookupUrl,
      secret: config.lookupSecret,
      tenant: config.lookupTenant,
    });
  }

  console.log(`Bridge data dir: ${bridgeDataDir()}`);
};

// The port frees within ~1s after the previous bridge exits (slow child
// teardown, task-scheduler restarts) — a short listen retry beats dying on
// EADDRINUSE. 8788 belongs to the bridge alone, so a retry always wins.
let attempt = 0;
server.on("error", (err) => {
  if (err.code !== "EADDRINUSE") {
    // Throwing inside this handler falls into the uncaughtException net: the
    // process would linger alive while listening on NOTHING. Exit loudly.
    console.error(`[listener] cannot listen on port ${config.port} (${err.code ?? "no_code"}): ${redactSecrets(err.message)} - exiting.`);
    process.exit(1);
  }
  const retry = () => {
    attempt += 1;
    if (attempt > 10) {
      console.error(`[listener] could not get port ${config.port} after 10 attempts - exiting.`);
      process.exit(1);
    }
    console.warn(`[listener] port ${config.port} not free yet (old bridge is slow to exit) - retry ${attempt}/10...`);
    setTimeout(() => server.listen(config.port, "127.0.0.1", onListening), 400);
  };
  retry();
});
server.listen(config.port, "127.0.0.1", onListening);

process.on("SIGINT", () => {
  console.log("\n[bridge] bye");
  try {
    tunnelController?.stop(); // kill the cloudflared child too — no orphan tunnel
  } catch {}
  try {
    unlinkSync(join(bridgeDataDir(), "bridge.pid"));
  } catch {}
  wipeLogs(); // tắt là xóa sạch log (owner 13/09)
  process.exit(0);
});

// Lưới an toàn: bridge là tiến trình dài hạn, một lỗi bất ngờ không được làm
// chết nó. Log và tiếp tục.
// Lỗi tới từ proxy/tunnel có thể nhúng URL đã mang token trong message/stack,
// nên in qua redactSecrets (cùng lý do mọi log khác: stdout của task VBS nằm
// trong bridge-task.log trên đĩa).
process.on("uncaughtException", (error) => {
  console.error("[bridge] uncaughtException:", redactSecrets(String(error?.stack ?? error)));
});
process.on("unhandledRejection", (error) => {
  console.error("[bridge] unhandledRejection:", redactSecrets(String(error?.stack ?? error)));
});