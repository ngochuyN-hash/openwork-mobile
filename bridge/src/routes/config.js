import { readJsonBody, sendJson } from "../http-util.js";
import { saveConfig } from "../config.js";

// Candidate 3 (06/10): config.json từng có HAI tay ghi — bridge (saveConfig) và
// GUI desktop ghi thẳng file. Từ nay GUI hết ghi file: mọi lần lưu định danh
// máy đi qua route này trên localhost để BRIDGE là người ghi duy nhất, config
// luôn nhất quán (một serializer, một lần bóp ACL trong saveConfig).
//
//   - Whitelist ĐÓNG 4 key định danh máy. mobileToken/ownerToken/port... không
//     bao giờ đặt được qua đây — route này là cửa hẹp, không phải cửa sau.
//   - MASTER token thôi (device đụng là 403): đổi định danh máy là việc của
//     người ngồi trước máy, điện thoại đã ghép không được đụng lookupSecret.
//   - machineName đi cùng phép làm sạch với /api/machine/name (routes/status.js).
const ALLOWED_KEYS = new Set(["lookupUrl", "lookupTenant", "lookupSecret", "machineName"]);

export function createConfigRoutes(ctx) {
  async function setIdentity({ req, res, device }) {
    if (device) {
      return sendJson(res, 403, {
        code: "master_only",
        message: "Machine identity is changed by the desktop app (master token) only.",
      });
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { code: "invalid_body", message: "Invalid JSON body" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendJson(res, 400, { code: "invalid_body", message: "Invalid JSON body" });
    }
    const applied = [];
    for (const [key, value] of Object.entries(body)) {
      if (!ALLOWED_KEYS.has(key) || typeof value !== "string") continue;
      if (key === "machineName") {
        ctx.config.machineName = value.replace(/[\r\n"']/g, "").trim().slice(0, 60);
      } else {
        ctx.config[key] = value.trim().slice(0, 300);
      }
      applied.push(key);
    }
    if (applied.length === 0) {
      return sendJson(res, 400, { code: "no_valid_keys", message: "No recognized machine-identity key in the body." });
    }
    saveConfig(ctx.config);
    // Log chỉ ghi TÊN key — lookupSecret là mật khẩu phòng, không lọt vào log.
    console.log(`[bridge] machine identity updated via local API: ${applied.join(", ")}`);
    sendJson(res, 200, { ok: true, applied });
  }

  return [
    { method: "POST", match: "/api/config/identity", handle: setIdentity },
  ];
}
