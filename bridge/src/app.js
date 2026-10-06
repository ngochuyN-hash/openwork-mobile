import http from "node:http";
import { deny, isTokenAuthorized, requestToken } from "./auth.js";
import { sendJson } from "./http-util.js";
import { openworkStateInfo } from "./openwork-state.js";
import { createRateLimiter } from "./rate-limit.js";
import { matchRoute } from "./router.js";
import { createPairingRoutes } from "./routes/pairing.js";
import { createStatusRoutes } from "./routes/status.js";
import { createConfigRoutes } from "./routes/config.js";
import { createOpenWorkRoutes } from "./routes/openwork.js";
import { createFsRoutes } from "./routes/fs.js";
import { createProxyRoutes } from "./routes/proxy.js";

/**
 * Dựng bề mặt HTTP của bridge. Tách khỏi index.js (vốn chạy ngay khi được
 * import: đọc config, spawn tiến trình, listen cổng) để handleRequest —
 * 500 dòng route trước đây nằm trong một file không export gì — trở thành thứ
 * test được: gọi thẳng với req/res giả, không cần bridge thật chạy.
 *
 * Mọi thứ route cần đều đi qua `deps`; không đọc module-level state nào.
 * `deps.tunnel` là object giữ 2 hàm (`getState`/`restart`) vì chúng được
 * index.js thay vào lúc tunnel lên — route luôn gọi qua ctx.tunnel nên thấy
 * bản mới nhất.
 */
export function createApp(deps) {
  const { config, state, bridgeVersion, handleStatic, refreshDiscovery, tunnel, getBaseUrl, pairing } = deps;

  const ctx = {
    config,
    state,
    pairing,
    bridgeVersion,
    refreshDiscovery,
    tunnel,
    getBaseUrl,
    openworkStateInfo: () => openworkStateInfo(config),
    // /api/pair: tối đa 10 lần/phút/IP - chống dò mã.
    pairLimiter: createRateLimiter({ limit: 10 }),
    // /api/openwork/*: 5 lần/phút/IP - chống bấm liên tục mở nhiều app.
    wakeLimiter: createRateLimiter({ limit: 5 }),
  };

  const routes = [
    ...createPairingRoutes(ctx),
    ...createStatusRoutes(ctx),
    ...createConfigRoutes(ctx),
    ...createOpenWorkRoutes(ctx),
    ...createFsRoutes(),
    ...createProxyRoutes(ctx),
  ];

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
      const route = matchRoute(routes, req, pathname);
      // Hai route ghép thiết bị chạy TRƯỚC cổng khóa: người lạ phải ghép được
      // thì mới vào được, không có token trong tay.
      if (route?.public) return route.handle({ req, res, url, pathname, device: null, ctx });

      // Các route còn lại: master token (owm_) hoặc khóa thiết bị (owd_).
      // requestToken() lấy từ header HOẶC ?_t= (GET) — cả hai đều phải được
      // công nhận như nhau, vì <a>/<img>/EventSource không set được header.
      const token = requestToken(req, url);
      const device = token ? pairing.authenticate(token) : null;
      if (!isTokenAuthorized(token, config.mobileToken) && !device) return deny(res);

      if (route) return route.handle({ req, res, url, pathname, device, ctx });
      return sendJson(res, 404, { code: "not_found" });
    }

    // Static web app
    if (req.method === "GET" || req.method === "HEAD") return handleStatic(req, res, pathname);
    res.writeHead(405);
    res.end();
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error("[bridge] request error:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { code: "internal_error", message: String(error?.message ?? error) });
      } else {
        res.end();
      }
    });
  });

  return { server, handleRequest, ctx, routes };
}