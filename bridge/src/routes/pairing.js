import qrcode from "../vendor/qrcode-terminal/index.js";
import { deny, isTokenAuthorized } from "../auth.js";
import { readJsonBody, sendJson } from "../http-util.js";
import { CODE_TTL_MINUTES } from "../pairing.js";

// Nhóm "ghép thiết bị": pair, đăng nhập phòng, danh sách/khoá thiết bị, mã QR.
// Đây là hai route DUY NHẤT không cần token — người lạ phải ghép được thì mới
// vào được, nên chúng nằm trước cổng khóa.
export function createPairingRoutes(ctx) {
  // Ghép thiết bị mới: KHÔNG cần token, chỉ cần mã one-time từ QR/terminal
  async function pair({ req, res }) {
    const ip = req.socket.remoteAddress ?? "?";
    if (ctx.pairLimiter.limited(ip)) return deny(res);
    try {
      const body = await readJsonBody(req);
      const result = ctx.pairing.pair(body?.code, body?.label);
      if (!result) {
        return sendJson(res, 401, { code: "invalid_code", message: `Wrong code, already used, or expired (codes live ${CODE_TTL_MINUTES} minutes). Get a new code from the bridge terminal.` });
      }
      console.log(`[pairing] new device paired: ${result.device.label} (${result.device.id})`);
      sendJson(res, 200, result);
    } catch {
      sendJson(res, 400, { code: "invalid_body", message: "Invalid JSON body" });
    }
  }

  // Đăng nhập multi-tenant từ web: user+pass do chủ worker cấp (thay cho mã
  // one-time). Chỉ hoạt động khi máy đã tham gia phòng: `openpocket edge join`.
  async function pairTenant({ req, res }) {
    const ip = req.socket.remoteAddress ?? "?";
    if (ctx.pairLimiter.limited(ip)) return deny(res);
    try {
      const body = await readJsonBody(req);
      const { config } = ctx;
      if (!config.lookupTenant || !config.lookupSecret) {
        return sendJson(res, 404, { code: "not_joined", message: "This computer has not joined any room. Run this on the computer: openpocket edge join" });
      }
      const userOk = String(body?.user ?? "").trim().toLowerCase() === config.lookupTenant;
      const passOk = isTokenAuthorized(String(body?.secret ?? ""), config.lookupSecret);
      if (!userOk || !passOk) {
        return sendJson(res, 401, { code: "invalid_credentials", message: "Wrong login name or password." });
      }
      const result = ctx.pairing.mintDevice(body?.label);
      console.log(`[pairing] room login ${config.lookupTenant}: new device "${result.device.label}" (${result.device.id})`);
      sendJson(res, 200, {
        ...result,
        tenant: config.lookupTenant,
        machineName: config.machineName || config.lookupTenant,
      });
    } catch {
      sendJson(res, 400, { code: "invalid_body", message: "Invalid JSON body" });
    }
  }

  function listDevices({ res }) {
    sendJson(res, 200, { devices: ctx.pairing.list() });
  }

  function revokeDevice({ res, pathname }) {
    const id = pathname.split("/").pop();
    const ok = ctx.pairing.revoke(id);
    sendJson(res, ok ? 200 : 404, ok ? { ok: true, devices: ctx.pairing.list() } : { code: "not_found" });
  }

  // Mã ghép ĐANG SỐNG cho CLI (`openpocket code`) + GUI desktop — không phải
  // parse log nữa. Auth bắt buộc (master/device): mã ghép là thông tin quản
  // trị, không phát cho người lạ chưa token. baseUrl = tunnel/worker hiện
  // tại để CLI ghép QR. QR render ASCII bằng qrcode-terminal NGAY TẠI ĐÂY —
  // GUI desktop không phải gọi API QR ngoài (mã ghép không rời máy).
  //
  // MASTER URL + MASTER QR CHỈ cho caller là master (app.js: `device` = null
  // khi chìa khớp `config.mobileToken`, khác null khi chìa là device key).
  // Lý do: master token nhúng trong `/#t=` là thứ vĩnh viễn, gỡ device key không
  // thu hồi được nó — nếu device key gọi được route này thì chỉ cần GỌI MỘT
  // LẦN trước khi bị gỡ là cầm vĩnh viễn master, hỏng hẳn mô hình "mất máy →
  // gỡ là sạch". Device key vẫn nhận đủ phần ghép (code/pairUrl/qr) vì đó là
  // thông tin đã dành cho nó; thiếu 2 field master thì BỎ HẲN khỏi response
  // (không trả ""), dễ thấy bằng mắt khi soi network tab.
  function pairingCode({ res, device }) {
    const { config } = ctx;
    const isMaster = !device;
    const code = ctx.pairing.ensureCode();
    const pairUrl = `${ctx.getBaseUrl()}/#p=${code}${ctx.tenantHashSuffix()}`;
    let qr = "";
    qrcode.generate(pairUrl, { small: true }, (s) => {
      qr = s;
    });
    const payload = {
      ok: true,
      code,
      codeFormatted: `${code.slice(0, 4)}-${code.slice(4)}`,
      secondsLeft: ctx.pairing.codeSecondsLeft(),
      baseUrl: ctx.getBaseUrl(),
      tenant: config.lookupTenant || null,
      pairUrl,
      qr,
    };
    if (isMaster) {
      const masterUrl = `${ctx.getBaseUrl()}/#t=${config.mobileToken}${ctx.tenantHashSuffix()}`;
      let masterQr = "";
      qrcode.generate(masterUrl, { small: true }, (s) => {
        masterQr = s;
      });
      payload.masterUrl = masterUrl;
      payload.masterQr = masterQr;
    }
    sendJson(res, 200, payload);
  }

  return [
    { method: "POST", match: "/api/pair", public: true, handle: pair },
    { method: "POST", match: "/api/pair/tenant", public: true, handle: pairTenant },
    { method: "GET", match: "/api/devices", handle: listDevices },
    { method: "DELETE", match: /^\/api\/devices\/[^/]+$/, handle: revokeDevice },
    { method: "GET", match: "/api/pairing-code", handle: pairingCode },
  ];
}