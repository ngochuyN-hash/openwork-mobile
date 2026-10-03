// Dọn log bridge (owner yêu cầu 13/09: log không giữ lại quá 1 ngày, tắt app /
// dừng bridge là xóa sạch). Log CLI, task scheduler, watchdog và OTA nằm trong
// data dir. Mọi bên ghi đều mở kiểu append ("a" / ">>") nên TRUNCATE an toàn
// khi bridge còn chạy: handle cũ tự ghi tiếp ở EOF mới. Xóa hẳn file chỉ làm
// được sau khi tiến trình ghi đã chết (CLI stop / nút Dừng của GUI).
import { statSync, truncateSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { bridgeDataDir } from "./config.js";

export const LOG_NAMES = ["bridge.log", "bridge-task.log", "watchdog.log", "ota.log", "ota-watchdog.log"];

// Xóa sạch nội dung (truncate về 0 byte, giữ nguyên file).
export function wipeLogs(dir = bridgeDataDir()) {
  for (const name of LOG_NAMES) {
    try {
      truncateSync(join(dir, name), 0);
    } catch {}
  }
}

// Xóa hẳn file; còn ai giữ handle thì quay về truncate cho chắc.
export function deleteLogs(dir = bridgeDataDir()) {
  for (const name of LOG_NAMES) {
    const p = join(dir, name);
    try {
      unlinkSync(p);
      continue;
    } catch {}
    try {
      truncateSync(p, 0);
    } catch {}
  }
}

// Gọi lúc bridge khởi động: log sót từ hôm trước thì dọn — chặn trường hợp
// bridge chạy liên tục nhiều ngày chỉ được dọn đúng lúc restart.
export function rotateStaleLogs(dir = bridgeDataDir(), now = new Date()) {
  for (const name of LOG_NAMES) {
    const p = join(dir, name);
    try {
      const mtime = statSync(p).mtime;
      if (
        mtime.getFullYear() !== now.getFullYear() ||
        mtime.getMonth() !== now.getMonth() ||
        mtime.getDate() !== now.getDate()
      ) {
        truncateSync(p, 0);
      }
    } catch {}
  }
}

// Đúng nửa đêm giờ máy: truncate log rồi tự hẹn lại ngày mai. Timer unref để
// không giữ tiến trình sống khi mọi việc khác đã xong.
export function scheduleDailyWipe(dir = bridgeDataDir()) {
  const arm = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0); // nửa đêm hôm sau (giờ địa phương)
    const t = setTimeout(() => {
      wipeLogs(dir);
      console.log(`[${new Date().toISOString()}] [log] sang ngày mới — đã dọn log.`);
      arm();
    }, next.getTime() - now.getTime());
    if (typeof t.unref === "function") t.unref();
  };
  arm();
}
