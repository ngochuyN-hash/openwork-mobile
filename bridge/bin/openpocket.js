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
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
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
// Một readline DUY NHẤT dùng chung cho mọi câu hỏi (tạo interface mới nhiều
// lần trên cùng stdin sẽ mất các dòng đã vào bộ đệm của interface cũ). Output
// là "hố đen" nên mật khẩu gõ vào không hiện — prompt viết tay ra stdout.
let _askRl = null;
function askRl() {
  if (!_askRl) {
    _askRl = createInterface({
      input: process.stdin,
      output: new Writable({ write (_c, _e, cb) { cb(); } }),
      terminal: true,
    });
  }
  return _askRl;
}
async function ask(text) {
  process.stdout.write(text);
  return (await askRl().question("")).trim();
}
const askHidden = ask;
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
    // /RL HIGHEST: bridge (và daemon điều khiển màn hình sinh ra từ nó) chạy
    // quyền admin — SendInput mới chạm được vào app đang chạy Administrator
    // (UIPI chặn input chiều thường -> admin). Đánh đổi: lệnh từ điện thoại
    // cũng mang quyền admin, bù bằng khóa thiết bị/phòng sẵn có.
    const created = spawnSync(
      "schtasks",
      ["/Create", "/TN", AUTOSTART_TASK_NAME, "/SC", "ONLOGON", "/TR", buildAutostartAction(), "/RL", "HIGHEST", "/F"],
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
  if (sub === "add" && !rest.some((a) => /^https:\/\//i.test(a))) {
    const url = process.env.OWM_WORKER_URL || config.lookupUrl;
    if (url) rest.push(url.replace(/\/+$/, ""));
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
  console.log(`Tạo phòng "${user}" — đặt mật khẩu (gõ sẽ KHÔNG hiện, tối thiểu 8 ký tự, không dấu cách / : / &):`);
  const pass = await askHidden("  Mật khẩu: ");
  const pass2 = await askHidden("  Nhập lại lần nữa: ");
  if (pass !== pass2) {
    console.log("❌ Hai lần nhập không khớp — chạy lại lệnh.");
    process.exit(1);
  }
  if (pass.length < 8 || /[\s:&]/.test(pass)) {
    console.log("❌ Mật khẩu cần ≥ 8 ký tự, không chứa dấu cách, ':' hay '&' (phải nằm gọn trong link mời).");
    process.exit(1);
  }
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
  // Tìm URL pair tương ứng (worker hoặc tunnel mới nhất, có thể kèm &m=phòng)
  const urls = [...text.matchAll(/https:\/\/[^\s]+\/#p=[A-Z2-9]+/gi)];
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
    // Ưu tiên worker (địa chỉ cố định) nếu máy đã join phòng; kèm &m= để web tự điền
    const base = (config.lookupUrl || `http://127.0.0.1:${config.port || 8788}`).replace(/\/+$/, "");
    const mSuffix = config.lookupTenant ? `&m=${encodeURIComponent(config.lookupTenant)}` : "";
    const masterUrl = `${base}/#t=${config.mobileToken}${mSuffix}`;
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
  openpocket edge join <link-mời|worker>  Tham gia "phòng" trên worker chung (dán link mời là được, 1 lần)
  openpocket edge status                  Xem phòng đang tham gia
  openpocket add <ten-dang-nhap> ["Tên"]  Cấp phòng cho bạn mới — tự hỏi đặt mật khẩu, xong hiện link mời
  openpocket tenant add <user> "Tên"      Cấp phòng (mật khẩu tự sinh) + thẻ mời tự copy
  openpocket tenant list                  Xem các phòng đang có
  openpocket tenant revoke <user>         Xóa phòng
  openpocket autostart --enable [--with-openwork]   Tự chạy bridge khi đăng nhập Windows
  openpocket autostart --status                     Xem tự chạy đang bật hay tắt
  openpocket autostart --disable                    Tắt tự chạy`);
process.exit(0);
