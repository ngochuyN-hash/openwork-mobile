import { existsSync, statSync } from "node:fs";
import { deny } from "../auth.js";
import { saveConfig } from "../config.js";
import { readJsonBody, sendJson } from "../http-util.js";
import { isOpenWorkExeName, launchOpenWork, normalizeExePathInput } from "../openwork-launch.js";

// Nhóm "bật / trỏ OpenWork từ điện thoại". Cả hai route đều rate limit 5
// lần/phút/IP vì phone bấm liên tục rất dễ.
export function createOpenWorkRoutes(ctx) {
  // Bật OpenWork desktop từ điện thoại (khi máy tính đang bật + bridge chạy
  // nhưng app OpenWork chưa mở).
  async function wake({ req, res }) {
    const ip = req.socket.remoteAddress ?? "?";
    if (ctx.wakeLimiter.limited(ip)) return deny(res);
    try {
      const result = await launchOpenWork({ configOpenworkExe: ctx.config.openworkExe });
      if (result.alreadyRunning) {
        await ctx.refreshDiscovery({ force: true });
        return sendJson(res, 200, { ok: true, alreadyRunning: true, server: ctx.state.server });
      }
      sendJson(res, 200, { ok: true, launched: true, hint: "OpenWork đang mở — đợi ~20s rồi bấm Kiểm tra lại." });
    } catch (error) {
      const code = error?.code === "openwork_exe_not_found" ? "openwork_exe_not_found" : "wake_failed";
      sendJson(res, code === "wake_failed" ? 500 : 404, { code, message: String(error?.message ?? error), candidates: error?.candidates ?? undefined });
    }
  }

  // User chỉ tay file OpenWork.exe (điện thoại gõ hoặc bấm 1 trong danh
  // sách ứng viên) → lưu vào config để "bật từ xa" không chết.
  // TUYỆT ĐỐI KHÔNG spawn/thực thi path này: đường dẫn do điện thoại gõ tới,
  // coi nó là lệnh chạy là lỗ hổng RCE. Kiểm tra gồm exists + isFile + tên
  // file phải đúng là OpenWork.exe — vì path lưu vào config.openworkExe sẽ bị
  // /api/openwork/wake và auto-launch lúc boot spawn() thật. exists+isFile
  // một mình là không đủ: nó vẫn lọt qua mọi file thực thi trên máy.
  async function setPath({ req, res }) {
    const ip = req.socket.remoteAddress ?? "?";
    if (ctx.wakeLimiter.limited(ip)) return deny(res);
    const bad = (code, message) => sendJson(res, 400, { code, message });
    try {
      const body = await readJsonBody(req);
      const raw = body?.path;
      if (typeof raw !== "string" || !raw.trim()) {
        return bad("invalid_path", "Chưa nhận đường dẫn file OpenWork.exe.");
      }
      // Bóc dấu nháy trước khi đo độ dài: "Copy as path" trong PowerShell cho ra
      // "C:\...\OpenWork.exe" CÓ dấu nháy kép, dán nguyên xi thì không bao giờ
      // khớp file thật.
      const path = normalizeExePathInput(raw);
      if (!path) {
        return bad("invalid_path", "Chưa nhận đường dẫn file OpenWork.exe.");
      }
      if (path.length > 400) {
        return bad("invalid_path", "Đường dẫn quá dài (tối đa 400 ký tự).");
      }
      if (!existsSync(path)) {
        return bad("not_found", "Không có file nào ở đường dẫn này — kiểm tra lại hoặc copy đường dẫn từ File Explorer.");
      }
      if (!statSync(path).isFile()) {
        return bad("not_a_file", "Đường dẫn này là thư mục — cần trỏ tới file OpenWork.exe.");
      }
      if (!isOpenWorkExeName(path)) {
        return bad("not_openwork_exe", "Chỉ nhận đúng file OpenWork.exe — file này tên khác, không phải OpenWork.");
      }
      ctx.config.openworkExe = path;
      saveConfig(ctx.config);
      console.log(`[openwork] user chỉ đường dẫn OpenWork.exe: ${path}`);
      sendJson(res, 200, { ok: true, openwork: ctx.openworkStateInfo() });
    } catch (error) {
      // Body JSON hỏng (SyntaxError / "body too large" từ readJsonBody) khác
      // hẳn với path không đọc được (existsSync/statSync ném lỗi fs).
      const bodyBroken = error instanceof SyntaxError || error?.message === "body too large";
      sendJson(res, 400, bodyBroken ? { code: "invalid_body", message: "Body JSON không hợp lệ" } : { code: "fs_error", message: "Không đọc được đường dẫn này — kiểm tra lại, hoặc thử copy từ ổ đĩa local." });
    }
  }

  return [
    { method: "POST", match: "/api/openwork/wake", handle: wake },
    { method: "POST", match: "/api/openwork/path", handle: setPath },
  ];
}