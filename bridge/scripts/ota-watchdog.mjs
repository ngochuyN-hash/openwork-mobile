// OTA watchdog (16/09/2026) — tiến trình ĐỘC LẬP spawn bởi update.js trước khi
// bridge tự respawn. Nó theo dõi pid của bridge CŨ và file state:
//   - pid cũ chết = bridge cũ đã nhường đời
//   - chờ tới WATCHDOG_DEADLINE_MS: bridge mới ghi phase "done" (qua markBootOk
//     sau khi listen OK) → watchdog tự thoát, mọi thứ ổn
//   - quá deadline mà state vẫn "applying" = bản mới vỡ/không boot được →
//     tự rollback: xóa src mới, trả .ota-backup về src, respawn bridge cũ
// Spawn detached + kế thừa token elevated của cha nên quyền ghi file/restart
// không bao giờ thiếu — đây là lưới an toàn cuối: update vỡ không bao giờ
// làm chết máy vĩnh viễn.
//
// ARGV: <pidCu> <stateFile> <bridgeRoot> <entryScript>
import { existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const [pidOld, stateFile, bridgeRoot, entryScript] = process.argv.slice(2);
const DEADLINE_MS = 90_000;
const POLL_MS = 1000;

function log(msg) {
  try {
    writeFileSync(join(stateFile, "..", "ota-watchdog.log"), `${new Date().toISOString()} ${msg}\n`, { flag: "a" });
  } catch {}
}

function readState() {
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}

function oldPidAlive() {
  try {
    process.kill(Number(pidOld), 0);
    return true;
  } catch {
    return false; // EPERM cũng coi là sống (cùng quyền nên khó xảy ra)
  }
}

function respawnBridge() {
  try {
    // Detached + stdio ra file riêng — không nối vào console đã chết.
    const out = join(stateFile, "..", "ota.log");
    const fd = openSync(out, "a");
    const child = spawn(process.execPath, [entryScript], { detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
  } catch (e) {
    log(`respawn lỗi: ${e.message}`);
  }
}

(async () => {
  // Chờ pid cũ thực sự chết (bridge cũ exit ngay sau khi spawn mình).
  const t0 = Date.now();
  while (oldPidAlive() && Date.now() - t0 < 15_000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (oldPidAlive()) {
    log("pid cũ vẫn sống sau 15s — có gì đó lạ, thoát không đụng.");
    process.exit(0);
  }

  // Bridge mới (hoặc rollback) boot. Quan sát state tới deadline.
  let saw = null;
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const s = readState();
    if (!s) {
      log("state biến mất — bỏ qua, không rollback.");
      process.exit(0);
    }
    saw = s.phase;
    if (s.phase === "done") {
      log(`bridge mới (tới ${s.to}) xác nhận OK — kết thúc.`);
      process.exit(0);
    }
    if (s.phase === "rollback" || s.phase === "failed") {
      log(`state=${s.phase} — có tiến trình khác đã lo, thoát.`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // Quá deadline mà vẫn "applying": bản mới không boot được → rollback.
  log("DEADLINE — bản mới không xác nhận, rollback về backup.");
  const srcDir = join(bridgeRoot, "src");
  const backupDir = join(bridgeRoot, ".ota-backup");
  const state = readState() ?? {};
  try {
    if (existsSync(srcDir)) rmSync(srcDir, { recursive: true, force: true });
    if (existsSync(backupDir)) {
      renameSync(backupDir, srcDir);
      log("backup đã trả về src.");
    } else {
      log("KHÔNG có backup — chỉ xóa src mới hỏng, bridge hết đường tự dậy.");
    }
    writeFileSync(
      stateFile,
      JSON.stringify({ ...state, phase: "rollback", rolledBackAt: Date.now() }) + "\n",
      "utf8"
    );
    respawnBridge();
    log("đã respawn bridge bản cũ.");
  } catch (e) {
    log(`rollback lỗi: ${e.message}`);
  }
  setTimeout(() => process.exit(0), 2000);
})();