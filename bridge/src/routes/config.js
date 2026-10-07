import { readJsonBody, sendJson } from "../http-util.js";
import { applyIdentity } from "../identity.js";

// Candidate 3 (06/10): config.json từng có HAI tay ghi — bridge (saveConfig) và
// GUI desktop ghi thẳng file. Từ nay GUI hết ghi file: mọi lần lưu định danh
// máy đi qua route này trên localhost để BRIDGE là người ghi duy nhất, config
// luôn nhất quán (một serializer, một lần bóp ACL trong saveConfig).
//
//   - MASTER token thôi (device đụng là 403): đổi định danh máy là việc của
//     người ngồi trước máy, điện thoại đã ghép không được đụng lookupSecret.
//   - Whitelist + sanitize + ghi + log thuộc về module identity.js (candidate 1,
//     07/10) — route này chỉ là adapter mỏng, dùng chung y hệt với
//     /api/machine/name. Key nằm trong shared/identity-keys.txt: nguồn duy nhất
//     cũng là nơi build.bat sinh IdentityKeys.cs cho GUI C#.
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
    const applied = applyIdentity(ctx.config, body);
    if (applied.length === 0) {
      return sendJson(res, 400, { code: "no_valid_keys", message: "No recognized machine-identity key in the body." });
    }
    sendJson(res, 200, { ok: true, applied });
  }

  return [
    { method: "POST", match: "/api/config/identity", handle: setIdentity },
  ];
}
