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
import { bridgeDataDir, loadConfig } from "../src/config.js";

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
  }
  console.log("");
  console.log("Mở link trên điện thoại (hoặc gõ mã) để ghép — mã sống 30 phút, dùng 1 lần.");
  console.log("Địa chỉ cố định (bookmark 1 lần, dùng mãi): https://YOUR-WORKER.workers.dev");
  process.exit(0);
}

console.log(`openpocket — điều khiển OpenWork Mobile bridge
Dùng:
  openpocket start    Chạy bridge nền (tự sinh mã, tunnel, heartbeat)
  openpocket stop     Dừng bridge
  openpocket status   Xem bridge có chạy không
  openpocket logs     Xem log (tail 50 dòng, Ctrl+C để thoát)
  openpocket code     Xem mã ghép + link mở trên điện thoại`);
process.exit(0);
