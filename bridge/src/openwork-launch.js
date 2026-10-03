import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { discoverServer } from "./discovery.js";

// Mở OpenWork desktop từ xa (từ điện thoại, hoặc tự mở khi bridge khởi động).
//
// Ví von: máy tính là nhà đang mở cửa (bridge chạy), OpenWork là ông chủ
// đi vắng — module này đi mời ông chủ ra. Nếu cả nhà tắt điện (máy tắt/ngủ)
// thì chịu, phải bật máy lên trước.

// Thứ tự tìm file .exe: env OPENWORK_EXE -> config openworkExe ->
// các chỗ hay gặp trên Windows (đã kiểm chứng trên máy thật:
// %LOCALAPPDATA%\Programs\@openworkdesktop\OpenWork.exe).
export function candidateExePaths(configOpenworkExe = "") {
  const fromEnv = (process.env.OPENWORK_EXE || "").trim();
  const out = [];
  if (fromEnv) out.push(fromEnv);
  const fromConfig = String(configOpenworkExe || "").trim();
  if (fromConfig && fromConfig !== fromEnv) out.push(fromConfig);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    out.push(
      join(localAppData, "Programs", "@openworkdesktop", "OpenWork.exe"),
      join(localAppData, "Programs", "openwork", "OpenWork.exe"),
      join(programFiles, "OpenWork", "OpenWork.exe")
    );
  }
  return out;
}

export function findOpenWorkExe(configOpenworkExe = "") {
  for (const p of candidateExePaths(configOpenworkExe)) {
    try {
      if (p && existsSync(p)) return p;
    } catch {
      // bỏ qua path lỗi, thử chỗ tiếp theo
    }
  }
  return "";
}

/** true khi openwork-server đã trả lời (OpenWork đang mở). */
export async function isOpenWorkRunning(options = {}) {
  const found = await discoverServer(options).catch(() => null);
  return Boolean(found);
}

// Mở OpenWork desktop (chống mở 2 lần: đang chạy rồi thì thôi).
// Trả về {alreadyRunning} | {launched, exe} | ném lỗi openwork_exe_not_found.
export async function launchOpenWork({ configOpenworkExe = "", log = console.log } = {}) {
  if (await isOpenWorkRunning()) return { alreadyRunning: true };
  const exe = findOpenWorkExe(configOpenworkExe);
  if (!exe) {
    const error = new Error(
      "Không tìm thấy file OpenWork.exe trên máy tính. " +
        "Mở OpenWork bằng tay 1 lần, hoặc set đường dẫn trong config (openworkExe) / env OPENWORK_EXE."
    );
    error.code = "openwork_exe_not_found";
    error.candidates = candidateExePaths(configOpenworkExe);
    throw error;
  }
  // OpenWork.exe là ứng dụng GUI người dùng — KHÔNG dùng windowsHide kẻo app bị ẩn
  const child = spawn(exe, [], { detached: true, stdio: "ignore" });
  // A locked/missing exe fires async 'error' AFTER this function already
  // returned — without a listener it escapes as an uncaughtException.
  child.on("error", (err) => log(`[openwork] mở OpenWork lỗi: ${err.message}`));
  child.unref();
  log(`[openwork] đã mở OpenWork (${exe}, pid ${child.pid}) — đợi server lên...`);
  return { launched: true, exe };
}
