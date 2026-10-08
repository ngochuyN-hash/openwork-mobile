import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, win32 } from "node:path";
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
// `candidateExeEntries` giữ kèm "source" để báo cho điện thoại biết file tìm
// thấy đến từ đâu (env / config / chỗ hay gặp) — thứ tự phải khớp đúng
// candidateExePaths, nên hai hàm cùng lấy từ một chỗ.
export function candidateExeEntries(configOpenworkExe = "") {
  const fromEnv = (process.env.OPENWORK_EXE || "").trim();
  const out = [];
  if (fromEnv) out.push({ path: fromEnv, source: "env" });
  const fromConfig = String(configOpenworkExe || "").trim();
  if (fromConfig && fromConfig !== fromEnv) out.push({ path: fromConfig, source: "config" });
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    for (const path of [
      join(localAppData, "Programs", "@openworkdesktop", "OpenWork.exe"),
      join(localAppData, "Programs", "openwork", "OpenWork.exe"),
      join(programFiles, "OpenWork", "OpenWork.exe"),
    ]) {
      out.push({ path, source: "wellknown" });
    }
  }
  return out;
}

export function candidateExePaths(configOpenworkExe = "") {
  return candidateExeEntries(configOpenworkExe).map((entry) => entry.path);
}

// Tên file .exe của OpenWork. Mọi candidate ở trên đều trỏ tới đúng tên này,
// nên nó cũng là ranh giới an toàn cho đường dẫn do ĐIỆN THOẠI gõ tới:
// route POST /api/openwork/path lưu path vào config, và config.openworkExe
// sau đó bị spawn() thật (qua /api/openwork/wake hoặc auto-launch lúc boot).
// Không khoá theo tên file thì route đó chỉ là cửa sổ của RCE: trỏ vào
// C:\Windows\System32\calc.exe là bridge mở calc.exe. exists + isFile không
// đủ — phải đúng tên OpenWork.exe mới cho lọt tới chỗ spawn.
export function isOpenWorkExeName(candidatePath) {
  const p = String(candidatePath ?? "").trim();
  if (!p) return false;
  // Windows không phân biệt hoa/thường trong tên file, nên so cũng vậy.
  // win32.basename (không phải basename): path do điện thoại gõ luôn là kiểu
  // Windows, và basename của Linux/macOS không tách được dấu "\".
  return win32.basename(p).toLowerCase() === "openwork.exe";
}

// Dọn đường dẫn người dùng gõ/dán từ điện thoại trước khi kiểm tra.
// Việc cần làm: bóc dấu nháy. "Copy as path" trong PowerShell cho ra
// "C:\...\OpenWork.exe" (CÓ dấu nháy kép), Explorer thì không — người dùng
// dán nguyên xi vào ô trên điện thoại là existsSync() trả false và họ tưởng
// mình gõ sai. Bóc tới 2 lớp cho phép chuỗi đã bị bọc hai lần.
export function normalizeExePathInput(raw) {
  let p = String(raw ?? "").trim();
  for (let i = 0; i < 2; i += 1) {
    const wrapped = /^(['"])([\s\S]*)\1$/.exec(p);
    if (!wrapped) break;
    p = wrapped[2].trim();
  }
  return p;
}

export function findOpenWorkExe(configOpenworkExe = "") {
  for (const { path: p } of candidateExeEntries(configOpenworkExe)) {
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
      "OpenWork.exe not found on this computer. " +
        "Open OpenWork manually once, or set the path in config (openworkExe) / env OPENWORK_EXE."
    );
    error.code = "openwork_exe_not_found";
    error.candidates = candidateExePaths(configOpenworkExe);
    throw error;
  }
  // OpenWork.exe là ứng dụng GUI người dùng — KHÔNG dùng windowsHide kẻo app bị ẩn
  const child = spawn(exe, [], { detached: true, stdio: "ignore" });
  // A locked/missing exe fires async 'error' AFTER this function already
  // returned — without a listener it escapes as an uncaughtException.
  child.on("error", (err) => log(`[openwork] failed to launch OpenWork: ${err.message}`));
  child.unref();
  log(`[openwork] launched OpenWork (${exe}, pid ${child.pid}) - waiting for the server...`);
  return { launched: true, exe };
}
