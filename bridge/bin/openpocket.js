#!/usr/bin/env node
// Lệnh toàn cục `openpocket` — điều khiển bridge như 9remote:
//   openpocket start    chạy bridge nền (tự sinh mã, tunnel, heartbeat)
//   openpocket stop     dừng bridge
//   openpocket status   xem đang chạy không + mã ghép hiện tại
//   openpocket logs     xem log bridge
//   openpocket code     in mã ghép hiện tại (30 phút) + QR
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeDataDir, loadConfig, saveConfig } from "../src/config.js";
import { AUTOSTART_TASK_NAME, buildAutostartAction } from "../src/autostart.js";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const cmd = (args[0] || "help").toLowerCase();

function pidFile() {
  return join(bridgeDataDir(), "bridge.pid");
}
function logFile() {
  return join(bridgeDataDir(), "bridge.log");
}
function readPid() {
  try {
    const pid = Number(readFileSync(pidFile(), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return 0;
    process.kill(pid, 0);
    return pid;
  } catch {
    return 0;
  }
}

if (cmd === "start") {
  const pid = readPid();
  if (pid) {
    console.log(`✅ Bridge đang chạy rồi (pid ${pid}).`);
    console.log("   Mở terminal của bridge để xem QR, hoặc chạy: openpocket code");
    process.exit(0);
  }
  const { spawn } = await import("node:child_process");
  const { openSync } = await import("node:fs");
  const logFd = openSync(logFile(), "a");
  const entry = join(BIN_DIR, "..", "src", "index.js");
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(pidFile(), String(child.pid));
  console.log(`✅ Bridge đã chạy nền (pid ${child.pid}).`);
  console.log(`   Log: ${logFile()}`);
  console.log("   Đợi ~10s rồi chạy: openpocket code  (để xem mã ghép + QR)");
  process.exit(0);
}

if (cmd === "stop") {
  const pid = readPid();
  if (!pid) {
    console.log("Bridge không chạy.");
    process.exit(0);
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {}
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(pidFile());
  } catch {}
  console.log("🛑 Đã dừng bridge.");
  process.exit(0);
}

if (cmd === "status") {
  const pid = readPid();
  if (!pid) {
    console.log("❌ Bridge KHÔNG chạy. Chạy: openpocket start");
    process.exit(1);
  }
  console.log(`✅ Bridge đang chạy (pid ${pid}).`);
  try {
    const config = loadConfig();
    const mobilePreview = config.mobileToken ? `${config.mobileToken.slice(0, 8)}…` : "(chưa có)";
    console.log(`   Master token: ${mobilePreview}  (QR master xem trong log)`);
  } catch {}
  console.log("   Chạy: openpocket code  để xem mã ghép + QR.");
  process.exit(0);
}

if (cmd === "logs") {
  const { spawnSync } = await import("node:child_process");
  if (!existsSync(logFile())) {
    console.log("Chưa có log.");
    process.exit(0);
  }
  if (process.platform === "win32") {
    spawnSync("powershell", ["-NoProfile", "-Command", `Get-Content -Tail 50 -Wait "${logFile()}"`], { stdio: "inherit" });
  } else {
    spawnSync("tail", ["-n", "50", "-f", logFile()], { stdio: "inherit" });
  }
  process.exit(0);
}

if (cmd === "autostart") {
  // Tự chạy bridge khi đăng nhập Windows — qua Task Scheduler (schtasks),
  // không cần file .ps1/.cmd lẻ. Task chạy ẩn (bridge tự windowsHide),
  // log vẫn ra bridge.log như openpocket start.
  if (process.platform !== "win32") {
    console.log("autostart hiện chỉ hỗ trợ Windows (Task Scheduler).");
    process.exit(1);
  }
  const sub = (args[1] || "--status").toLowerCase();
  const withOpenwork = args.includes("--with-openwork");
  if (sub === "--enable") {
    const created = spawnSync(
      "schtasks",
      ["/Create", "/TN", AUTOSTART_TASK_NAME, "/SC", "ONLOGON", "/TR", buildAutostartAction(), "/F"],
      { stdio: "inherit" }
    );
    if (created.status !== 0) {
      console.log("");
      console.log("Không tạo được task — hãy mở terminal bằng Run as Administrator rồi chạy lại:");
      console.log("  openpocket autostart --enable" + (withOpenwork ? " --with-openwork" : ""));
      process.exit(1);
    }
    const config = loadConfig();
    config.autoLaunchOpenWork = withOpenwork ? true : config.autoLaunchOpenWork === true;
    saveConfig(config);
    console.log(`✅ Đã bật tự chạy khi đăng nhập Windows (task "${AUTOSTART_TASK_NAME}").`);
    console.log(withOpenwork
      ? "   Đăng nhập là mở luôn OpenWork desktop (--with-openwork đã lưu)."
      : "   Muốn mở luôn OpenWork desktop thì chạy lại kèm --with-openwork.");
    console.log("   Tắt bằng: openpocket autostart --disable");
    process.exit(0);
  }
  if (sub === "--disable") {
    spawnSync("schtasks", ["/Delete", "/TN", AUTOSTART_TASK_NAME, "/F"], { stdio: "inherit" });
    const config = loadConfig();
    if (config.autoLaunchOpenWork) {
      config.autoLaunchOpenWork = false;
      saveConfig(config);
    }
    console.log("🛑 Đã tắt tự chạy.");
    process.exit(0);
  }
  // --status (mặc định): task còn trong Scheduler không?
  const queried = spawnSync("schtasks", ["/Query", "/TN", AUTOSTART_TASK_NAME], { stdio: "pipe", encoding: "utf8" });
  if (queried.status === 0) {
    console.log(`✅ Tự chạy đang BẬT (task "${AUTOSTART_TASK_NAME}" trong Task Scheduler).`);
    try {
      const config = loadConfig();
      console.log(config.autoLaunchOpenWork
        ? "   Đăng nhập là mở luôn OpenWork desktop."
        : "   Chỉ chạy bridge (muốn mở luôn OpenWork: --enable --with-openwork).");
    } catch {}
  } else {
    console.log(`❌ Tự chạy đang TẮT. Bật bằng: openpocket autostart --enable`);
  }
  process.exit(0);
}

if (cmd === "code") {
  if (!existsSync(logFile())) {
    console.log("Bridge chưa chạy. Chạy: openpocket start");
    process.exit(1);
  }
  const text = readFileSync(logFile(), "utf8");
  // Tìm khối QR ghép MỚI NHẤT trong log (sau lần tunnel/code đổi gần nhất)
  const blocks = text.split(/Mã ghép:/);
  if (blocks.length < 2) {
    console.log("Chưa thấy mã ghép trong log — bridge đang khởi động, đợi ~10s rồi thử lại.");
    process.exit(1);
  }
  const latest = blocks[blocks.length - 1];
  const codeMatch = latest.match(/([A-Z2-9]{4}-[A-Z2-9]{4})/);
  // Tìm URL tunnel tương ứng (khối tunnel mới nhất chứa #p=)
  const urls = [...text.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\/#p=([A-Z2-9]+)/gi)];
  const lastUrl = urls.length ? urls[urls.length - 1][0] : null;
  console.log("");
  console.log(`📱 Mã ghép hiện tại: ${codeMatch ? codeMatch[1] : "(không đọc được)"}`);
  if (lastUrl) {
    console.log(`🔗 Link mở trên điện thoại:`);
    console.log(`   ${lastUrl}`);
    console.log("");
    console.log("QR quét trực tiếp:");
    const { default: qrcode } = await import("qrcode-terminal");
    qrcode.generate(lastUrl, { small: true });
  }
  console.log("");
  // Mã vĩnh viễn: đọc thẳng từ config (file local, an toàn vì lệnh chạy tại máy)
  try {
    const config = loadConfig();
    const masterUrl = `http://127.0.0.1:${config.port || 8788}/#t=${config.mobileToken}`;
    console.log("⭐ Mã VĨNH VIỄN (có hiệu lực mãi, chỉ dùng tại máy — đừng chia sẻ):");
    console.log(`   ${config.mobileToken}`);
    console.log("");
    console.log("QR master (quét 1 lần, dùng mãi — mở bằng camera, hoặc gõ mã trên):");
    const { default: qrcode } = await import("qrcode-terminal");
    qrcode.generate(masterUrl, { small: true });
  } catch {
    console.log("(không đọc được master token từ config)");
  }
  console.log("");
  console.log("Mã ghép sống 30 phút, dùng 1 lần. Master vĩnh viễn.");
  console.log("Địa chỉ cố định (bookmark 1 lần, dùng mãi): https://YOUR-WORKER.workers.dev");
  process.exit(0);
}

console.log(`openpocket — điều khiển OpenWork Mobile bridge
Dùng:
  openpocket start    Chạy bridge nền (tự sinh mã, tunnel, heartbeat)
  openpocket stop     Dừng bridge
  openpocket status   Xem bridge có chạy không
  openpocket logs     Xem log (tail 50 dòng, Ctrl+C để thoát)
  openpocket code     Xem mã ghép + link mở trên điện thoại
  openpocket autostart --enable [--with-openwork]   Tự chạy bridge khi đăng nhập Windows
  openpocket autostart --status                     Xem tự chạy đang bật hay tắt
  openpocket autostart --disable                    Tắt tự chạy`);
process.exit(0);
