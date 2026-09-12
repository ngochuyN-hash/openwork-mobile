import http from "node:http";
import { watch } from "node:fs";
import qrcode from "qrcode-terminal";
import { loadConfig, saveConfig, bridgeDataDir } from "./config.js";
import { ensureOwnerToken } from "./bootstrap.js";
import { discoverServer, checkTokenActive, readEngineRegistry, probeServerUrl } from "./discovery.js";
import { isAuthorized, isQueryAuthorized, deny } from "./auth.js";
import { proxyToOpenWork } from "./proxy.js";
import { createStaticHandler } from "./static.js";
import { openworkFilePath } from "./paths.js";
import { startQuickTunnel } from "./tunnel.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BRIDGE_VERSION = "0.1.0";
const __dirname = dirname(fileURLToPath(import.meta.url));

const config = loadConfig();

// ---------------------------------------------------------------------------
// 1. Bootstrap the owner token into OpenWork's tokens.json (one-time; needs a
//    single OpenWork restart to take effect).
// ---------------------------------------------------------------------------
const boot = ensureOwnerToken(config.ownerToken);
config.ownerToken = boot.token;
if (process.env.OPENWORK_PUBLIC_URL) config.publicUrl = process.env.OPENWORK_PUBLIC_URL.trim().replace(/\/+$/, "");
saveConfig(config);

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
// 3. HTTP server: the only surface exposed (127.0.0.1). Put `tailscale serve`
//    in front of it for remote HTTPS access from the phone.
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

  if (pathname.startsWith("/api/")) {
    if (!isAuthorized(req, config.mobileToken) && !isQueryAuthorized(req, url, config.mobileToken)) return deny(res);

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

// Long-lived SSE proxied connections need generous timeouts.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

// In QR pairing cho một URL gốc (local hoặc tunnel)
function printPairing(base, note) {
  const pairingUrl = `${base}/#t=${config.mobileToken}`;
  console.log("");
  if (note) console.log(note);
  console.log(`  ${pairingUrl}`);
  console.log("");
  qrcode.generate(pairingUrl, { small: true });
  console.log("");
}

server.listen(config.port, "127.0.0.1", () => {
  const local = `http://127.0.0.1:${config.port}`;
  console.log("");
  console.log(`OpenWork Mobile bridge v${BRIDGE_VERSION}`);
  console.log(`listening on ${local} (localhost only - remote đi qua tunnel bên dưới)`);
  console.log(`openwork-server: ${state.server ? state.server.baseUrl : "not found yet (waiting for OpenWork...)"}`);
  console.log(`token status: ${state.tokenActive ? "ACTIVE" : state.restartRequired ? "needs OpenWork restart (one time)" : "pending"}`);
  printPairing(config.publicUrl || local, "Mở link này (hoặc quét QR) trên điện thoại:");

  // Auto Cloudflare Quick Tunnel: public URL miễn phí, không cần tài khoản.
  // URL đổi mỗi lần cloudflared chạy lại -> tự in QR mới. Tắt bằng OPENWORK_BRIDGE_TUNNEL=0
  if (process.env.OPENWORK_BRIDGE_TUNNEL !== "0") {
    startQuickTunnel(config.port, {
      onUrl: (url) => {
        state.tunnelUrl = url;
        printPairing(url, `[tunnel] URL public MỚI (dùng được từ 4G, không cần app nào trên điện thoại):`);
      },
    }).catch((error) => console.error(`[tunnel] lỗi: ${error.message}`));
  }

  console.log(`Pairing token (manual entry): ${config.mobileToken}`);
  console.log(`Bridge data dir: ${bridgeDataDir()}`);
});

process.on("SIGINT", () => {
  console.log("\n[bridge] bye");
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
