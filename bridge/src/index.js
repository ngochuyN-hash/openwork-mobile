import http from "node:http";
import { readFileSync, watch, writeFileSync, unlinkSync } from "node:fs";
import qrcode from "qrcode-terminal";
import { loadConfig, saveConfig, bridgeDataDir } from "./config.js";
import { ensureOwnerToken } from "./bootstrap.js";
import { discoverServer, checkTokenActive, readEngineRegistry, probeServerUrl } from "./discovery.js";
import { isTokenAuthorized, requestToken, deny } from "./auth.js";
import { proxyToOpenWork } from "./proxy.js";
import { createStaticHandler } from "./static.js";
import { openworkFilePath } from "./paths.js";
import { startQuickTunnel } from "./tunnel.js";
import { startLookup } from "./lookup.js";
import { PairingService, CODE_TTL_MINUTES } from "./pairing.js";
import { findOpenWorkExe, launchOpenWork } from "./openwork-launch.js";
import { listDirs, listRoots, makeDir } from "./fslist.js";
import { rotateStaleLogs, scheduleDailyWipe, wipeLogs } from "./logwipe.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
// Trạng thái đường hầm cho /api/state + heartbeat lookup đọc (được thay bằng
// controller thật ngay khi startQuickTunnel chạy xong bên dưới).
let tunnelGetState = () => ({ phase: "starting", url: "", streak: 0, nextRetryAt: 0 });
// Restart thủ công — false = tunnel không chạy (OPENWORK_BRIDGE_TUNNEL=0 / chưa lên)
let tunnelRestart = () => false;
// Real tunnel controller — used to kill the cloudflared child on SIGINT.
let tunnelController = null;

// ---------------------------------------------------------------------------
// 1.5 Pairing kiểu 9Remote: mã one-time 30 phút trong QR + khóa thiết bị vĩnh viễn
// ---------------------------------------------------------------------------
const pairing = new PairingService();

// Địa chỉ in vào QR pair: ƯU TIÊN worker (địa chỉ CỐ ĐỊNH) nếu đã cấu hình —
// URL tunnel đổi mỗi lần cloudflared chạy lại, điện thoại giữ QR cũ sẽ hụt.
const currentBase = () =>
  (config.lookupUrl ? config.lookupUrl.replace(/\/+$/, "") : "") ||
  state.tunnelUrl ||
  config.publicUrl ||
  `http://127.0.0.1:${config.port}`;
// Gắn phòng vào link (#p=...&m=phòng / #t=...&m=phòng) để web tự điền.
const tenantHashSuffix = () => (config.lookupTenant ? `&m=${encodeURIComponent(config.lookupTenant)}` : "");
let printingPairing = false;
pairing.onCode = () => {
  // Mã mới (thiết bị vừa ghép xong hoặc mã cũ hết hạn) -> in lại QR
  if (!printingPairing) printPairing(currentBase(), "[pairing] mã ghép MỚI:");
};

// Rate limit thô cho /api/pair: tối đa 10 lần/phút/IP - chống dò mã
const pairAttempts = new Map();
function pairRateLimited(ip) {
  const now = Date.now();
  const list = (pairAttempts.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 10) {
    pairAttempts.set(ip, list);
    return true;
  }
  list.push(now);
  pairAttempts.set(ip, list);
  return false;
}

// Rate limit cho /api/openwork/wake: 5 lần/phút/IP - chống bấm liên tục mở nhiều app
const wakeAttempts = new Map();
function wakeRateLimited(ip) {
  const now = Date.now();
  const list = (wakeAttempts.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 5) {
    wakeAttempts.set(ip, list);
    return true;
  }
  list.push(now);
  wakeAttempts.set(ip, list);
  return false;
}

// Sweep stale IPs out of the rate-limit maps: entries past the 60s window are
// dead weight — without this both maps grow forever with every IP ever seen.
function sweepRateMaps() {
  const now = Date.now();
  for (const map of [pairAttempts, wakeAttempts]) {
    for (const [ip, list] of map) {
      const alive = list.filter((t) => now - t < 60_000);
      if (alive.length) map.set(ip, alive);
      else map.delete(ip);
    }
  }
}
setInterval(sweepRateMaps, 5 * 60_000).unref();

async function readJsonBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

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
      console.log(`[bridge] openwork-server found at ${found.baseUrl} (v${found.version}, opencode ${found.opencodeVersion})`);
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
    console.error(`[openwork] tự mở lúc khởi động lỗi: ${error.message}`)
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
// ---------------------------------------------------------------------------
const handleStatic = createStaticHandler(join(__dirname, "..", "..", "web", "dist"));

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error("[bridge] request error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "internal_error", message: String(error?.message ?? error) }));
    } else {
      res.end();
    }
  });
});

async function handleRequest(req, res) {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.port}`);
  const pathname = decodeURIComponent(url.pathname);

  // SSE (EventSource always sends Accept: text/event-stream): the connection
  // is long-lived and silent gaps are normal — clear the idle timeout for
  // THIS socket only; every other request keeps the server defaults.
  if (String(req.headers["accept"] ?? "").includes("text/event-stream")) {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
  }

  if (pathname.startsWith("/api/")) {
    // Ghép thiết bị mới: KHÔNG cần token, chỉ cần mã one-time từ QR/terminal
    if (req.method === "POST" && pathname === "/api/pair") {
      const ip = req.socket.remoteAddress ?? "?";
      if (pairRateLimited(ip)) return deny(res);
      try {
        const body = await readJsonBody(req);
        const result = pairing.pair(body?.code, body?.label);
        if (!result) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "invalid_code", message: `Mã không đúng, đã dùng hoặc hết hạn (mã sống ${CODE_TTL_MINUTES} phút). Lấy mã mới trong terminal bridge.` }));
          return;
        }
        console.log(`[pairing] thiết bị mới đã ghép: ${result.device.label} (${result.device.id})`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "invalid_body", message: "Body JSON không hợp lệ" }));
      }
      return;
    }

    // Đăng nhập multi-tenant từ web: user+pass do chủ worker cấp (thay cho mã
    // one-time). Chỉ hoạt động khi máy đã tham gia phòng: `openpocket edge join`.
    if (req.method === "POST" && pathname === "/api/pair/tenant") {
      const ip = req.socket.remoteAddress ?? "?";
      if (pairRateLimited(ip)) return deny(res);
      try {
        const body = await readJsonBody(req);
        if (!config.lookupTenant || !config.lookupSecret) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              code: "not_joined",
              message: "Máy này chưa tham gia phòng nào. Trên máy tính chạy: openpocket edge join",
            })
          );
          return;
        }
        const userOk = String(body?.user ?? "").trim().toLowerCase() === config.lookupTenant;
        const passOk = isTokenAuthorized(String(body?.secret ?? ""), config.lookupSecret);
        if (!userOk || !passOk) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "invalid_credentials", message: "Sai tên đăng nhập hoặc mật khẩu." }));
          return;
        }
        const result = pairing.mintDevice(body?.label);
        console.log(`[pairing] đăng nhập phòng ${config.lookupTenant}: thiết bị mới "${result.device.label}" (${result.device.id})`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...result,
            tenant: config.lookupTenant,
            machineName: config.machineName || config.lookupTenant,
          })
        );
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "invalid_body", message: "Body JSON không hợp lệ" }));
      }
      return;
    }

    // Các route còn lại: master token (owm_) hoặc khóa thiết bị (owd_).
    // requestToken() lấy từ header HOẶC ?_t= (GET) — cả hai đều phải được
    // công nhận như nhau, vì <a>/<img>/EventSource không set được header.
    const token = requestToken(req, url);
    const device = token ? pairing.authenticate(token) : null;
    if (!isTokenAuthorized(token, config.mobileToken) && !device) return deny(res);

    if (req.method === "GET" && pathname === "/api/devices") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ devices: pairing.list() }));
      return;
    }
    if (req.method === "DELETE" && /^\/api\/devices\/[^/]+$/.test(pathname)) {
      const id = pathname.split("/").pop();
      const ok = pairing.revoke(id);
      res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { ok: true, devices: pairing.list() } : { code: "not_found" }));
      return;
    }

    // Mã ghép ĐANG SỐNG cho CLI (`openpocket code`) + GUI desktop — không phải
    // parse log nữa. Auth bắt buộc (master/device): mã ghép là thông tin quản
    // trị, không phát cho người lạ chưa token. baseUrl = tunnel/worker hiện
    // tại để CLI ghép QR. QR render ASCII bằng qrcode-terminal NGAY TẠI ĐÂY —
    // GUI desktop không phải gọi API QR ngoài (mã ghép không rời máy).
    if (req.method === "GET" && pathname === "/api/pairing-code") {
      const code = pairing.ensureCode();
      const pairUrl = `${currentBase()}/#p=${code}${tenantHashSuffix()}`;
      const masterUrl = `${currentBase()}/#t=${config.mobileToken}${tenantHashSuffix()}`;
      let qr = "";
      let masterQr = "";
      qrcode.generate(pairUrl, { small: true }, (s) => {
        qr = s;
      });
      qrcode.generate(masterUrl, { small: true }, (s) => {
        masterQr = s;
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          code,
          codeFormatted: `${code.slice(0, 4)}-${code.slice(4)}`,
          secondsLeft: pairing.codeSecondsLeft(),
          baseUrl: currentBase(),
          tenant: config.lookupTenant || null,
          pairUrl,
          qr,
          masterUrl,
          masterQr,
        })
      );
      return;
    }

    if (req.method === "GET" && pathname === "/api/state") {
      const engine = readEngineRegistry();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          bridgeVersion: BRIDGE_VERSION,
          dataDir: bridgeDataDir(),
          server: state.server
            ? { baseUrl: state.server.baseUrl, version: state.server.version, opencodeVersion: state.server.opencodeVersion }
            : null,
          tokenActive: state.tokenActive,
          restartRequired: state.restartRequired,
          engine: engine ? { pid: engine.ownerPid, enginePort: engine.port } : null,
          publicUrl: state.tunnelUrl || config.publicUrl || null,
          tunnel: tunnelGetState(),
          edge: { tenant: config.lookupTenant || null, machineName: config.machineName || null },
          devices: pairing.list().length,
          pairingCodeSecondsLeft: pairing.codeSecondsLeft(),
          openworkExeFound: Boolean(findOpenWorkExe(config.openworkExe)),
          autoLaunchOpenWork: config.autoLaunchOpenWork === true,
          thisDevice: device ? { id: device.id, label: device.label } : { id: "master", label: "Master token (owm_)" },
        })
      );
      return;
    }

    if (req.method === "POST" && pathname === "/api/recheck") {
      await refreshDiscovery({ force: true });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: state.server, tokenActive: state.tokenActive, restartRequired: state.restartRequired }));
      return;
    }

    // Restart tunnel THỦ CÔNG (nút "Restart tunnel" GUI): chủ động xin tunnel
    // mới thay vì đợi bộ đếm backoff 429 (đôi khi hên xui — IP đã đổi mà vẫn
    // kẹt hẹn cũ trong tunnel-state.json). Bridge giữ nguyên, chỉ cloudflared
    // được thay; URL mới có rồi bridge tự đăng ký lại lên worker như thường.
    if (req.method === "POST" && pathname === "/api/tunnel/restart") {
      if (!tunnelRestart()) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            code: "tunnel_inactive",
            message: "Tunnel không chạy (OPENWORK_BRIDGE_TUNNEL=0 hoặc đang restart dở).",
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, tunnel: tunnelGetState() }));
      return;
    }

    // Đổi tên máy (ô "Tên máy" trong GUI desktop): cập nhật config trong RAM +
    // file NGAY — đăng nhập mới trên điện thoại thấy tên mới qua /api/pair/
    // tenant, /api/state cũng báo theo. Không cần restart bridge.
    if (req.method === "POST" && pathname === "/api/machine/name") {
      try {
        const body = await readJsonBody(req);
        const name = String(body?.name ?? "")
          .replace(/[\r\n"']/g, "")
          .trim()
          .slice(0, 60);
        if (!name) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "invalid_name", message: "Tên máy trống." }));
          return;
        }
        config.machineName = name;
        saveConfig(config);
        console.log(`[bridge] tên máy mới: ${name}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, machineName: name }));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "invalid_body", message: "Body JSON không hợp lệ" }));
      }
      return;
    }

    // Bật OpenWork desktop từ điện thoại (khi máy tính đang bật + bridge chạy
    // nhưng app OpenWork chưa mở). Chống bấm liên tục: 5 lần/phút/IP.
    if (req.method === "POST" && pathname === "/api/openwork/wake") {
      const ip = req.socket.remoteAddress ?? "?";
      if (wakeRateLimited(ip)) return deny(res);
      try {
        const result = await launchOpenWork({ configOpenworkExe: config.openworkExe });
        if (result.alreadyRunning) {
          await refreshDiscovery({ force: true });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, alreadyRunning: true, server: state.server }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, launched: true, hint: "OpenWork đang mở — đợi ~20s rồi bấm Kiểm tra lại." }));
        }
      } catch (error) {
        const code = error?.code === "openwork_exe_not_found" ? "openwork_exe_not_found" : "wake_failed";
        res.writeHead(code === "wake_failed" ? 500 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify({ code, message: String(error?.message ?? error), candidates: error?.candidates ?? undefined }));
      }
      return;
    }

    // Duyệt thư mục máy tính để tạo workspace khỏi gõ tay đường dẫn.
    // Chỉ liệt kê THƯ MỤC (không file), nằm sau khóa thiết bị như các API khác.
    if (req.method === "GET" && pathname === "/api/fs/ls") {
      const target = url.searchParams.get("path")?.trim();
      try {
        const result = target ? await listDirs(target) : { ...(await listRoots()), ok: true };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(error?.code === "ENOENT" || error?.code === "ENOTDIR" ? 404 : 403, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ code: error?.code ?? "fs_error", message: String(error?.message ?? error) }));
      }
      return;
    }

    // Tạo thư mục mới con cho nút "+ Thư mục mới" trong picker (cùng khu khóa thiết bị).
    if (req.method === "POST" && pathname === "/api/fs/mkdir") {
      try {
        const body = await readJsonBody(req);
        const result = await makeDir(body?.dir, body?.name);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(error?.code === "EEXIST" || error?.code === "EINVAL" ? 400 : 403, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ code: error?.code ?? "fs_error", message: String(error?.message ?? error) }));
      }
      return;
    }

    if (pathname.startsWith("/api/ow/")) {
      if (!state.server || !state.tokenActive) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            code: state.restartRequired ? "restart_required" : "upstream_unavailable",
            message: state.restartRequired
              ? "OpenWork must be restarted once to activate the bridge token."
              : "openwork-server not reachable (is OpenWork running?).",
          })
        );
        return;
      }
      const upstreamPath = pathname.slice("/api/ow".length) || "/";
      await proxyToOpenWork(req, res, upstreamPath, { baseUrl: state.server.baseUrl, ownerToken: config.ownerToken });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "not_found" }));
    return;
  }

  // Static web app
  if (req.method === "GET" || req.method === "HEAD") return handleStatic(req, res, pathname);
  res.writeHead(405);
  res.end();
}

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
  const pairingUrl = `${base}/#p=${code}${tenantHashSuffix()}`;
  console.log("");
  if (note) console.log(note);
  console.log(`  QR ghép thiết bị (mã 1 lần, hết hạn sau ${CODE_TTL_MINUTES} phút):`);
  console.log(`  ${pairingUrl}`);
  console.log(`  Mã ghép: ${code.slice(0, 4)}-${code.slice(4)}`);
  console.log("");
  qrcode.generate(pairingUrl, { small: true });
  if (withMaster) {
    const masterUrl = `${base}/#t=${config.mobileToken}${tenantHashSuffix()}`;
    console.log("  QR MASTER (token vĩnh viễn — chỉ dùng tại máy, TUYỆT ĐỐI không chia sẻ):");
    console.log(`  ${masterUrl}`);
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
  console.log(`listening on ${local} (localhost only - remote đi qua tunnel bên dưới)`);
  console.log(`openwork-server: ${state.server ? state.server.baseUrl : "not found yet (waiting for OpenWork...)"}`);
  console.log(`token status: ${state.tokenActive ? "ACTIVE" : state.restartRequired ? "needs OpenWork restart (one time)" : "pending"}`);
  // QR thứ 1 (mã one-time 30 phút): để ghép thiết bị mới — hết hạn tự chết.
  // QR thứ 2 (master token): vĩnh viễn, chỉ in tại máy để chủ máy tiện tay
  // nhập thẳng trên điện thoại của mình — TUYỆT ĐỐI không chụp/chia sẻ.
  printPairing(config.publicUrl || local, "Mở link này (hoặc quét QR) trên điện thoại:", {
    withMaster: true,
  });

  // Auto Cloudflare Quick Tunnel: public URL miễn phí, không cần tài khoản.
  // URL đổi mỗi lần cloudflared chạy lại -> tự in QR mới. Tắt bằng OPENWORK_BRIDGE_TUNNEL=0
  if (process.env.OPENWORK_BRIDGE_TUNNEL !== "0") {
    startQuickTunnel(config.port, {
      onUrl: (url) => {
        state.tunnelUrl = url;
        // Tunnel URL là public — chỉ in QR mã one-time, KHÔNG in QR master.
        printPairing(currentBase(), "[tunnel] URL public MỚI (dùng được từ 4G, không cần app nào trên điện thoại):");
      },
    })
      .then((tunnel) => {
        tunnelController = tunnel;
        tunnelGetState = () => tunnel.getState();
        tunnelRestart = () => tunnel.restart();
      })
      .catch((error) => console.error(`[tunnel] lỗi: ${error.message}`));
  }

  // Heartbeat lên Cloudflare Worker (địa chỉ cố định) nếu đã cấu hình:
  // điện thoại mở đúng 1 URL duy nhất, tự tìm được bridge dù tunnel đổi.
  if (config.lookupUrl && config.lookupSecret) {
    console.log(
      `[lookup] reporting tới ${config.lookupUrl}${config.lookupTenant ? ` (phòng: ${config.lookupTenant})` : ""}`
    );
    startLookup({
      getUrl: () => state.tunnelUrl,
      getState: () => tunnelGetState(),
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
    console.error(`[listener] cannot listen on port ${config.port} (${err.code ?? "no_code"}): ${err.message} - exiting.`);
    process.exit(1);
  }
  const retry = () => {
    attempt += 1;
    if (attempt > 10) {
      console.error(`[listener] không lấy được cổng ${config.port} sau 10 lần — thoát.`);
      process.exit(1);
    }
    console.warn(`[listener] cổng ${config.port} chưa nhả (bridge cũ tắt chậm) — thử lại lần ${attempt}/10...`);
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
process.on("uncaughtException", (error) => {
  console.error("[bridge] uncaughtException:", error);
});
process.on("unhandledRejection", (error) => {
  console.error("[bridge] unhandledRejection:", error);
});
