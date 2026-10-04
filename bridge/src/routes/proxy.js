import { proxyToOpenWork } from "../proxy.js";
import { sendJson } from "../http-util.js";

// Đường cuối cùng trong /api/: mọi thứ dưới /api/ow/ chuyển thẳng cho
// openwork-server, kèm owner token. Prefix, không phải route cụ thể — nên nó
// PHẢI đứng cuối bảng route, sau khi mọi route /api/ cụ thể đã khớp.
export function createProxyRoutes(ctx) {
  async function proxy({ req, res, pathname }) {
    const { state } = ctx;
    if (!state.server || !state.tokenActive) {
      return sendJson(res, 503, {
        code: state.restartRequired ? "restart_required" : "upstream_unavailable",
        message: state.restartRequired
          ? "OpenWork must be restarted once to activate the bridge token."
          : "openwork-server not reachable (is OpenWork running?).",
      });
    }
    const upstreamPath = pathname.slice("/api/ow".length) || "/";
    await proxyToOpenWork(req, res, upstreamPath, { baseUrl: state.server.baseUrl, ownerToken: ctx.config.ownerToken });
  }

  return [{ method: "*", match: "*/api/ow/", handle: proxy }];
}