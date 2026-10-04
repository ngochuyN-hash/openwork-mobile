import { bridgeDataDir, saveConfig } from "../config.js";
import { readEngineRegistry } from "../discovery.js";
import { readJsonBody, sendJson } from "../http-util.js";

// Nhóm "trạng thái & điều khiển": xem máy, ép quét lại, restart tunnel, đổi tên.
export function createStatusRoutes(ctx) {
  function state({ res, device }) {
    const { config, state } = ctx;
    const engine = readEngineRegistry();
    const openworkInfo = ctx.openworkStateInfo();
    sendJson(res, 200, {
      ok: true,
      bridgeVersion: ctx.bridgeVersion,
      dataDir: bridgeDataDir(),
      server: state.server
        ? { baseUrl: state.server.baseUrl, version: state.server.version, opencodeVersion: state.server.opencodeVersion }
        : null,
      tokenActive: state.tokenActive,
      restartRequired: state.restartRequired,
      engine: engine ? { pid: engine.ownerPid, enginePort: engine.port } : null,
      publicUrl: state.tunnelUrl || config.publicUrl || null,
      tunnel: ctx.tunnel.getState(),
      edge: { tenant: config.lookupTenant || null, machineName: config.machineName || null },
      devices: ctx.pairing.list().length,
      pairingCodeSecondsLeft: ctx.pairing.codeSecondsLeft(),
      openworkExeFound: openworkInfo.found, // boolean cũ: web + code khác vẫn đọc
      openwork: openworkInfo,
      autoLaunchOpenWork: config.autoLaunchOpenWork === true,
      thisDevice: device ? { id: device.id, label: device.label } : { id: "master", label: "Master token (owm_)" },
    });
  }

  async function recheck({ res }) {
    await ctx.refreshDiscovery({ force: true });
    const { state } = ctx;
    sendJson(res, 200, { ok: true, server: state.server, tokenActive: state.tokenActive, restartRequired: state.restartRequired });
  }

  // Restart tunnel THỦ CÔNG (nút "Restart tunnel" GUI): chủ động xin tunnel
  // mới thay vì đợi bộ đếm backoff 429 (đôi khi hên xui — IP đã đổi mà vẫn
  // kẹt hẹn cũ trong tunnel-state.json). Bridge giữ nguyên, chỉ cloudflared
  // được thay; URL mới có rồi bridge tự đăng ký lại lên worker như thường.
  function restartTunnel({ res }) {
    if (!ctx.tunnel.restart()) {
      return sendJson(res, 409, {
        code: "tunnel_inactive",
        message: "Tunnel không chạy (OPENWORK_BRIDGE_TUNNEL=0 hoặc đang restart dở).",
      });
    }
    sendJson(res, 200, { ok: true, tunnel: ctx.tunnel.getState() });
  }

  // Đổi tên máy (ô "Tên máy" trong GUI desktop): cập nhật config trong RAM +
  // file NGAY — đăng nhập mới trên điện thoại thấy tên mới qua /api/pair/
  // tenant, /api/state cũng báo theo. Không cần restart bridge.
  async function machineName({ req, res }) {
    try {
      const body = await readJsonBody(req);
      const name = String(body?.name ?? "")
        .replace(/[\r\n"']/g, "")
        .trim()
        .slice(0, 60);
      if (!name) {
        return sendJson(res, 400, { code: "invalid_name", message: "Tên máy trống." });
      }
      ctx.config.machineName = name;
      saveConfig(ctx.config);
      console.log(`[bridge] tên máy mới: ${name}`);
      sendJson(res, 200, { ok: true, machineName: name });
    } catch {
      sendJson(res, 400, { code: "invalid_body", message: "Body JSON không hợp lệ" });
    }
  }

  return [
    { method: "GET", match: "/api/state", handle: state },
    { method: "POST", match: "/api/recheck", handle: recheck },
    { method: "POST", match: "/api/tunnel/restart", handle: restartTunnel },
    { method: "POST", match: "/api/machine/name", handle: machineName },
  ];
}