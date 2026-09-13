#!/usr/bin/env node
// Lệnh toàn cục `openpocket` — điều khiển bridge như 9remote:
//   openpocket start    chạy bridge nền (tự sinh mã, tunnel, heartbeat)
//   openpocket stop     dừng bridge
//   openpocket status   xem đang chạy không + mã ghép hiện tại
//   openpocket logs     xem log bridge
//   openpocket code     in mã ghép hiện tại (30 phút) + QR
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { bridgeDataDir, loadConfig, saveConfig } from "../src/config.js";
import { AUTOSTART_TASK_NAME, WATCHDOG_TASK_NAME, bridgeEntryPath, buildAutostartAction } from "../src/autostart.js";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const cmd = (args[0] || "help").toLowerCase();

function pidFile() {
  return join(bridgeDataDir(), "bridge.pid");
}
function logFile() {
  return join(bridgeDataDir(), "bridge.log");
}
// Một bộ đọc stdin DUY NHẤT cho mọi câu hỏi, xử lý phím ở mức thô (không
// readline): mỗi phím có phản hồi NGAY trên màn hình — dòng thường hiện chữ,
// mật khẩu hiện thành * — Backspace xóa được, Enter xuống dòng rõ. Cụ cũ là
// readline với output "hố đen" (để ẩn mật khẩu) nuốt LUÔN phản hồi gõ phím:
// user gõ mà màn hình im re, Enter cũng không thấy gì, tưởng phím chết.
// Dòng bơm dồn từ stdin pipe (script/test) vẫn ăn: chưa có người chờ thì xếp
// hàng đợi, câu hỏi sau lấy tiếp. Ctrl+C tự thoát (raw mode không sinh
// SIGINT), chuỗi ESC của phím mũi tên/F-key bị lọc khỏi nội dung gõ.
const _decoder = new StringDecoder("utf8");
let _stdinHooked = false;
let _inputLine = "";
let _escSkip = false;
let _lastWasCR = false;
let _echoMask = null; // "*" khi hỏi mật khẩu, null khi gõ hiện nguyên chữ
const _lineQueue = [];
let _lineWaiter = null;

function hookStdin() {
  if (_stdinHooked) return;
  _stdinHooked = true;
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
    // process.exit() nhảy cóc có thể bỏ qua bước dọn của node — chủ động trả
    // console về chế độ thường kẻo shell sau khi lệnh chạy xong bị lỗi hành vi.
    process.on("exit", () => {
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      } catch {}
    });
  }
  process.stdin.on("data", onStdinChunk);
  process.stdin.resume();
}

function deliverLine(line) {
  const waiter = _lineWaiter;
  if (waiter) {
    _lineWaiter = null;
    waiter(line);
  } else {
    _lineQueue.push(line);
  }
}

function onStdinChunk(chunk) {
  for (const ch of _decoder.write(chunk)) {
    if (_escSkip) {
      if (/[A-Za-z~]/.test(ch)) _escSkip = false; // byte kết thúc chuỗi ESC/CSI
      continue;
    }
    if (ch === "\x1b") { _escSkip = true; continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\n" && _lastWasCR) { _lastWasCR = false; continue; } // \r\n = một Enter
      _lastWasCR = ch === "\r";
      const line = _inputLine;
      _inputLine = "";
      process.stdout.write("\n");
      deliverLine(line);
      continue;
    }
    _lastWasCR = false;
    if (ch === "\b" || ch === "\x7f") {
      if (_inputLine.length) {
        _inputLine = _inputLine.slice(0, -1);
        process.stdout.write("\b \b");
      }
    } else if (ch === "\x03") {
      process.stdout.write("^C\n");
      process.exit(130);
    } else if (ch >= " ") {
      _inputLine += ch;
      process.stdout.write(_echoMask ?? ch);
    }
  }
}

async function ask(text, { hidden = false } = {}) {
  process.stdout.write(text);
  hookStdin();
  _echoMask = hidden ? "*" : null;
  const line = _lineQueue.length
    ? _lineQueue.shift()
    : await new Promise((resolve) => { _lineWaiter = resolve; });
  _echoMask = null;
  return line.trim();
}
const askHidden = (text) => ask(text, { hidden: true });
// Mật khẩu phòng: chủ máy tự đặt; Enter để trống thì dùng mặc định 12345678 —
// đỡ vắt óc đặt pass cho phòng dùng thử. Đổi sau bằng revoke + add.
const DEFAULT_TENANT_PASS = "12345678";
async function askTenantPass() {
  const pass = await askHidden("  Mật khẩu (Enter = dùng mặc định 12345678): ");
  if (!pass) {
    console.log("  → Dùng mật khẩu mặc định 12345678 (muốn đổi: revoke rồi add lại).");
    return DEFAULT_TENANT_PASS;
  }
  const pass2 = await askHidden("  Nhập lại lần nữa: ");
  if (pass !== pass2) {
    console.log("❌ Hai lần nhập không khớp — chạy lại lệnh.");
    process.exit(1);
  }
  if (pass.length < 8 || /[\s:&]/.test(pass)) {
    console.log("❌ Mật khẩu cần ≥ 8 ký tự, không chứa dấu cách, ':' hay '&' (phải nằm gọn trong link mời).");
    process.exit(1);
  }
  return pass;
}
function readPid() {
  try {
    const pid = Number(readFileSync(pidFile(), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return 0;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // Process khác session/quyền (vd: task elevated) — kiểm tra qua tasklist.
      // Chỉ tin khi đúng là tiến trình node (tránh nhầm pid đã tái sử dụng).
      if (process.platform === "win32") {
        try {
          // File này là ESM — không có `require`; dùng spawnSync đã import trên đầu.
          const probe = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
            encoding: "utf8",
            timeout: 5000,
          });
          if (new RegExp(`"node(\\.exe)?","${pid}"`).test(probe.stdout || "")) return pid;
        } catch {}
      }
      return 0;
    }
  } catch {
    return 0;
  }
}

// Cổng bridge còn ai nghe không — phép thử nối TCP nhanh. Dùng để tôn trọng
// instance chạy NGOÀI CLI (chưa kịp ghi pid file): cổng còn người nghe là
// KHÔNG start thêm bản nữa đè lên nhau (EADDRINUSE — sự cố sáng 13/09).
async function portBusy(port) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: 800 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
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

if (cmd === "ensure") {
  // Cho máy canh (task hẹn giờ gọi định kỳ): bridge sống thì thôi, chết thì
  // dựng lại — im lặng, không hỏi gì, an toàn để chạy mỗi 5 phút.
  const pid = readPid();
  const port = loadConfig().port || 8788;
  if (pid) {
    console.log(`[${new Date().toISOString()}] bridge sống (pid ${pid}) — không làm gì.`);
    process.exit(0);
  }
  if (await portBusy(port)) {
    console.log(
      `[${new Date().toISOString()}] cổng ${port} có người nghe nhưng không pid — instance ngoài CLI vẫn sống, không start thêm.`
    );
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
  writeFileSync(pidFile(), String(child.pid));
  console.log(`[${new Date().toISOString()}] bridge đã chết — máy canh dựng lại (pid ${child.pid}).`);
  process.exit(0);
}

if (cmd === "status") {
  const pid = readPid();
  if (!pid) {
    if (await portBusy(loadConfig().port || 8788)) {
      console.log("⚠️ Có instance bridge chạy NGOÀI CLI (chưa ghi pid file — init bản cũ).");
      console.log("   Cổng vẫn phục vụ bình thường; muốn CLI quản được thì restart instance đó 1 lần.");
    } else {
      console.log("❌ Bridge KHÔNG chạy. Chạy: openpocket start");
    }
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
  // Task elevated (VBS) ghi bridge-task.log; openpocket start ghi bridge.log —
  // đọc file MỚI HƠN để luôn thấy log của instance đang chạy.
  let logTarget = logFile();
  try {
    const taskLog = join(bridgeDataDir(), "bridge-task.log");
    if (existsSync(taskLog) && statSync(taskLog).mtimeMs > statSync(logTarget).mtimeMs) logTarget = taskLog;
  } catch {}
  if (!existsSync(logTarget)) {
    console.log("Chưa có log.");
    process.exit(0);
  }
  if (process.platform === "win32") {
    spawnSync("powershell", ["-NoProfile", "-Command", `Get-Content -Tail 50 -Wait "${logTarget}"`], { stdio: "inherit" });
  } else {
    spawnSync("tail", ["-n", "50", "-f", logTarget], { stdio: "inherit" });
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
    // /RL HIGHEST: bridge (và daemon điều khiển màn hình sinh ra từ nó) chạy
    // quyền admin — SendInput mới chạm được vào app đang chạy Administrator
    // (UIPI chặn input chiều thường -> admin). Đánh đổi: lệnh từ điện thoại
    // cũng mang quyền admin, bù bằng khóa thiết bị/phòng sẵn có.
    // Task chay qua wrapper VBS AN CUA SO: task ONLOGON interactive bat buoc
    // (SendInput phai nam trong desktop cua user), nhung node truc tiep se co
    // cua so console den - user dong nham la bridge chet mat log (da gap that).
    // VBS chay node khong console + gom stdout/stderr vao bridge-task.log.
    const vbsPath = join(bridgeDataDir(), "bridge-task.vbs");
    writeFileSync(
      vbsPath,
      [
        'Set sh = CreateObject("WScript.Shell")',
        `sh.CurrentDirectory = "${join(BIN_DIR, "..")}"`,
        `sh.Run "cmd /c """""${process.execPath}"" ""${bridgeEntryPath()}"" >> ""${join(bridgeDataDir(), "bridge-task.log")}" 2>&1""", 0, False`,
      ].join("\r\n") + "\r\n",
      "utf8"
    );
    const created = spawnSync(
      "schtasks",
      ["/Create", "/TN", AUTOSTART_TASK_NAME, "/SC", "ONLOGON", "/TR", `"wscript.exe" "${vbsPath}"`, "/RL", "HIGHEST", "/F"],
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

if (cmd === "watchdog") {
  // Máy canh: task hẹn giờ 5 PHÚT chạy `openpocket ensure` (ẩn, cùng quyền
  // admin với task autostart) — bridge bị kill ngoài CLI/crash ngầm là tự
  // hồi sinh trong 5 phút, không phải đợi reboot hay ai đó mở tay (bài học
  // đêm 13/09: bridge chết lúc 08:03, cả nhà tưởng "Cloudflare chặn").
  if (process.platform !== "win32") {
    console.log("watchdog hiện chỉ hỗ trợ Windows (Task Scheduler).");
    process.exit(1);
  }
  const sub = (args[1] || "--status").toLowerCase();
  if (sub === "--install" || sub === "--enable") {
    const vbsPath = join(bridgeDataDir(), "bridge-watchdog.vbs");
    const self = fileURLToPath(import.meta.url);
    writeFileSync(
      vbsPath,
      [
        'Set sh = CreateObject("WScript.Shell")',
        `sh.CurrentDirectory = "${join(BIN_DIR, "..")}"`,
        `sh.Run "cmd /c """""${process.execPath}"" ""${self}"" ensure >> ""${join(bridgeDataDir(), "watchdog.log")}" 2>&1""", 0, False`,
      ].join("\r\n") + "\r\n",
      "utf8"
    );
    const created = spawnSync(
      "schtasks",
      ["/Create", "/TN", WATCHDOG_TASK_NAME, "/SC", "MINUTE", "/MO", "5", "/TR", `"wscript.exe" "${vbsPath}"`, "/RL", "HIGHEST", "/F"],
      { stdio: "inherit" }
    );
    if (created.status !== 0) {
      console.log("");
      console.log("Không tạo được task — mở terminal Run as Administrator rồi chạy lại:");
      console.log("  openpocket watchdog --install");
      process.exit(1);
    }
    console.log(`✅ Máy canh đã BẬT: mỗi 5 phút tự chạy "openpocket ensure" (task "${WATCHDOG_TASK_NAME}").`);
    console.log("   Tắt bằng: openpocket watchdog --uninstall");
    process.exit(0);
  }
  if (sub === "--uninstall" || sub === "--disable") {
    spawnSync("schtasks", ["/Delete", "/TN", WATCHDOG_TASK_NAME, "/F"], { stdio: "inherit" });
    console.log("🛑 Đã tắt máy canh.");
    process.exit(0);
  }
  const queried = spawnSync("schtasks", ["/Query", "/TN", WATCHDOG_TASK_NAME], { stdio: "pipe", encoding: "utf8" });
  console.log(
    queried.status === 0
      ? `✅ Máy canh đang BẬT (task "${WATCHDOG_TASK_NAME}", 5 phút/lần).`
      : `❌ Máy canh đang TẮT. Bật bằng: openpocket watchdog --install`
  );
  process.exit(0);
}

if (cmd === "edge") {
  // Tham gia "phòng" trên worker chung (multi-tenant): cặp user/pass do chủ
  // worker cấp, nhập 1 lần — bridge heartbeat lên phòng đó mãi về sau.
  const sub = (args[1] || "status").toLowerCase();
  const config = loadConfig();
  const TENANT_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

  if (sub === "join") {
    const arg = String(args[2] ?? "").trim();
    let workerUrl = (arg || config.lookupUrl || "").replace(/\/+$/, "");
    let user = "";
    let pass = "";
    // Dán nguyên LINK MỜI (.../#i=user:secret) cũng được — tự bóc user/pass,
    // khỏi gõ gì thêm.
    const linkMatch = /#i=([A-Za-z0-9][A-Za-z0-9-]{0,31}):([^&\s]+)$/.exec(arg);
    if (linkMatch) {
      try {
        workerUrl = new URL(arg).origin;
      } catch {}
      user = linkMatch[1].toLowerCase();
      pass = linkMatch[2];
      console.log(`Đọc được phòng "${user}" từ link mời.`);
    }
    if (!/^https:\/\//i.test(workerUrl)) {
      console.log("Dùng: openpocket edge join <link-mời hoặc địa-chỉ-worker>");
      console.log("vd:   openpocket edge join https://YOUR-WORKER.workers.dev/#i=nam:owes_xxx");
      process.exit(1);
    }

    let name = "";
    if (user) {
      console.log(`Tham gia phòng trên worker: ${workerUrl}`);
      name = await ask("Tên máy hiển thị trên web (Enter để bỏ qua): ");
    } else {
      console.log(`Tham gia phòng trên worker: ${workerUrl}`);
      user = (await ask("Tên đăng nhập (mã phòng): ")).toLowerCase();
      pass = await askHidden("Mật khẩu: ");
      name = await ask("Tên máy hiển thị trên web (Enter để bỏ qua): ");
    }
    if (!TENANT_RE.test(user)) {
      console.log("❌ Tên đăng nhập chỉ gồm a-z, 0-9 và dấu gạch ngang, 2-32 ký tự (vd: nam).");
      process.exit(1);
    }
    if (!pass) {
      console.log("❌ Chưa nhập mật khẩu.");
      process.exit(1);
    }
    config.lookupUrl = workerUrl;
    config.lookupTenant = user;
    config.lookupSecret = pass;
    if (name) config.machineName = name;
    saveConfig(config);
    console.log(`✅ Đã ghi phòng "${user}" vào config.`);
    if (readPid()) {
      console.log("🔁 Bridge đang chạy — khởi động lại để nhận phòng mới…");
      const self = fileURLToPath(import.meta.url);
      spawnSync(process.execPath, [self, "stop"], { stdio: "inherit" });
      spawnSync(process.execPath, [self, "start"], { stdio: "inherit" });
      console.log("   Xong! Đợi ~15s để bridge đăng ký tunnel lên worker.");
    } else {
      console.log("   Bridge chưa chạy — mở bằng: openpocket start");
    }
    process.exit(0);
  }

  if (sub === "status") {
    const pid = readPid();
    console.log(`Bridge     : ${pid ? `đang chạy (pid ${pid})` : "không chạy (openpocket start)"}`);
    if (config.lookupTenant) {
      console.log(`Phòng      : ${config.lookupTenant}${config.machineName ? ` (${config.machineName})` : ""}`);
      console.log(`Worker     : ${config.lookupUrl}`);
      console.log("Web        : mở worker ở trên → tab Đăng nhập, dùng cùng cặp user/pass.");
    } else {
      console.log("Phòng      : (không tham gia — chạy luồng máy chính machine:main)");
      console.log("Muốn tham gia phòng: openpocket edge join <địa-chỉ-worker>");
    }
    process.exit(0);
  }

  console.log("Dùng: openpocket edge join <địa-chỉ-worker> | openpocket edge status");
  process.exit(1);
}

if (cmd === "tenant") {
  // Cấp/quản lý phòng multi-tenant mà KHÔNG cần nhớ đường dẫn script worker:
  //   openpocket tenant add <user> "Tên hiển thị" [địa-chỉ-worker]
  //   openpocket tenant list
  //   openpocket tenant revoke <user>
  // Không truyền URL worker thì tự lấy từ config máy này (lookupUrl) — máy đã
  // heartbeat lên worker nào thì cấp phòng cho worker đó.
  const sub = (args[1] || "list").toLowerCase();
  const script = join(BIN_DIR, "..", "..", "worker", "scripts", "tenant.mjs");
  if (!existsSync(script)) {
    console.log("Không tìm thấy worker/scripts/tenant.mjs cạnh thư mục bridge — chạy từ repo dự án.");
    process.exit(1);
  }
  const config = loadConfig();
  const rest = args.slice(2);
  if (sub === "add" && !rest.includes("--pass")) {
    // --pass có sẵn (đường scripted/không tương tác) thì đi thẳng, không hỏi.
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(rest[0] || "")) {
      console.log('Dùng: openpocket tenant add <user> "Tên hiển thị" [địa-chỉ-worker]');
      console.log("      user chỉ gồm a-z, 0-9, dấu gạch ngang (vd: nam). Mật khẩu sẽ được hỏi sau.");
      process.exit(1);
    }
    if (!rest.some((a) => /^https:\/\//i.test(a))) {
      const url = process.env.OWM_WORKER_URL || config.lookupUrl;
      if (url) rest.push(url.replace(/\/+$/, ""));
    }
    const pass = await askTenantPass();
    rest.push("--pass", pass);
  }
  const result = spawnSync(process.execPath, [script, sub, ...rest], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

if (cmd === "add") {
  // openpocket add martinez  →  hỏi đặt mật khẩu → cấp phòng → hiện link mời.
  // Chỉ CHỦ worker chạy được (cần wrangler login đúng tài khoản trên máy này).
  const user = (args[1] || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(user)) {
    console.log('Dùng: openpocket add <ten-dang-nhap> ["Tên hiển thị"]');
    console.log("      ten-dang-nhap chỉ gồm a-z, 0-9, dấu gạch ngang (vd: martinez)");
    process.exit(1);
  }
  const script = join(BIN_DIR, "..", "..", "worker", "scripts", "tenant.mjs");
  if (!existsSync(script)) {
    console.log("Không tìm thấy worker/scripts/tenant.mjs cạnh thư mục bridge — chạy từ repo dự án.");
    process.exit(1);
  }
  console.log(`Tạo phòng "${user}" — mật khẩu gõ vào sẽ hiện thành *** (≥8 ký tự, không dấu cách / : / &; Enter để trống = mặc định 12345678):`);
  const pass = await askTenantPass();
  const config = loadConfig();
  const url = process.env.OWM_WORKER_URL || config.lookupUrl;
  if (!url || !/^https:\/\//i.test(url)) {
    console.log("❌ Chưa biết địa chỉ worker — đặt env OWM_WORKER_URL hoặc chạy: openpocket edge status để xem.");
    process.exit(1);
  }
  const nameArg = args[2] && !/^https?:/i.test(args[2]) ? [args[2]] : [];
  const result = spawnSync(process.execPath, [script, "add", user, ...nameArg, url, "--pass", pass], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

if (cmd === "code") {
  const { default: qrcode } = await import("qrcode-terminal");
  const config = loadConfig();
  const port = config.port || 8788;
  const baseFixed = (config.lookupUrl || "").replace(/\/+$/, ""); // worker = địa chỉ cố định (ưu tiên)
  const mSuffix = config.lookupTenant ? `&m=${encodeURIComponent(config.lookupTenant)}` : "";

  // 1) Lấy mã ĐANG SỐNG từ API của bridge (đúng nhất — log có thể stale).
  let live = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/pairing-code`, {
      headers: { authorization: `Bearer ${config.mobileToken}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) live = await res.json();
  } catch {}

  // 2) Fallback: bridge cũ (chưa có endpoint) hoặc chưa chạy — parse log.
  if (!live) {
    if (!existsSync(logFile())) {
      console.log("Bridge chưa chạy. Chạy: openpocket start");
      process.exit(1);
    }
    const text = readFileSync(logFile(), "utf8");
    const blocks = text.split(/Mã ghép:/);
    const latest = blocks[blocks.length - 1];
    const codeMatch = latest?.match(/([A-Z2-9]{4}-?[A-Z2-9]{4})/);
    const urls = [...text.matchAll(/https:\/\/[^\s]+\/#p=([A-Z2-9]+)/gi)];
    if (!codeMatch && !urls.length) {
      console.log("Không đọc được mã ghép — bridge đang khởi động, đợi ~10s rồi thử lại.");
      process.exit(1);
    }
    const raw = codeMatch ? codeMatch[1].replace(/-/g, "") : urls[urls.length - 1][1];
    const urlBase = (urls.length ? new URL(urls[urls.length - 1][0]).origin : `http://127.0.0.1:${port}`);
    live = {
      code: raw,
      codeFormatted: `${raw.slice(0, 4)}-${raw.slice(4)}`,
      baseUrl: urlBase === `http://127.0.0.1:${port}` && baseFixed ? baseFixed : urlBase,
      secondsLeft: null,
    };
  }

  // Base cho QR: worker cố định (nếu có) > tunnel hiện tại > localhost.
  const pairBase = baseFixed || live.baseUrl || `http://127.0.0.1:${port}`;
  const pairUrl = `${pairBase}/#p=${live.code}${mSuffix}`;
  const minutesLeft = live.secondsLeft != null ? Math.ceil(live.secondsLeft / 60) : null;

  console.log("");
  console.log(`📱 MÃ GHÉP (1 lần${minutesLeft != null ? `, còn ~${minutesLeft} phút` : ", sống 30 phút"}): ${live.codeFormatted}`);
  console.log(`🔗 Mở trên điện thoại: ${pairUrl}`);
  console.log("");
  console.log("QR ghép thiết bị — quét để vào:");
  qrcode.generate(pairUrl, { small: true });

  // 3) Mã vĩnh viễn — đọc từ config máy này (chỉ in tại máy, đừng chia sẻ).
  if (config.mobileToken) {
    const masterUrl = `${baseFixed || `http://127.0.0.1:${port}`}/#t=${config.mobileToken}${mSuffix}`;
    console.log("");
    console.log("⭐ MÃ VĨNH VIỄN (không hết hạn, chỉ dùng tại máy — đừng chụp/chia sẻ):");
    console.log(`   ${config.mobileToken}`);
    console.log("");
    console.log("QR master — quét 1 lần, dùng mãi:");
    qrcode.generate(masterUrl, { small: true });
  }

  console.log("");
  console.log(`Địa chỉ cố định (bookmark 1 lần, dùng mãi): ${baseFixed || "chưa cấu hình (openpocket edge join)"}`);
  process.exit(0);
}

console.log(`openpocket — điều khiển OpenWork Mobile bridge
Dùng:
  openpocket start    Chạy bridge nền (tự sinh mã, tunnel, heartbeat)
  openpocket stop     Dừng bridge
  openpocket status   Xem bridge có chạy không
  openpocket logs     Xem log (tail 50 dòng, Ctrl+C để thoát)
  openpocket code     Xem mã ghép + link mở trên điện thoại
  openpocket edge join <link-mời|worker>  Tham gia "phòng" trên worker chung (dán link mời là được, 1 lần)
  openpocket edge status                  Xem phòng đang tham gia
  openpocket add <ten-dang-nhap> ["Tên"]  Cấp phòng cho bạn mới — hỏi đặt mật khẩu (Enter = 12345678), xong hiện link mời
  openpocket tenant add <user> "Tên"      Cấp phòng — hỏi đặt mật khẩu (Enter = 12345678) + thẻ mời tự copy
  openpocket tenant list                  Xem các phòng đang có
  openpocket tenant revoke <user>         Xóa phòng
  openpocket autostart --enable [--with-openwork]   Tự chạy bridge khi đăng nhập Windows
  openpocket autostart --status                     Xem tự chạy đang bật hay tắt
  openpocket autostart --disable                    Tắt tự chạy
  openpocket watchdog --install   Máy canh: mỗi 5 phút tự dựng lại bridge nếu nó chết (cần admin 1 lần)
  openpocket watchdog --status    Xem máy canh bật hay tắt
  openpocket watchdog --uninstall Tắt máy canh
  openpocket ensure               Chạy thầm lặng: bridge sống thì thôi, chết thì dựng (lệnh của máy canh)`);
process.exit(0);
