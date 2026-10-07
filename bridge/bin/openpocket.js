#!/usr/bin/env node
// Lệnh toàn cục `openpocket` — điều khiển bridge như 9remote.
// Sau cú rút gọn 1-PC (13/09): CLI chỉ còn việc QUẢN MÁY NÀY — hết edge join,
// hết cấp phòng/link mời, hết hỏi mật khẩu terminal (định danh máy được cấp
// ngầm qua GUI/POST /api/tenant/create; admin phòng hiếm hoi dùng wrangler thẳng).
//   openpocket start    chạy bridge nền (tự sinh mã, tunnel, heartbeat)
//   openpocket stop     dừng bridge
//   openpocket status   xem đang chạy không
//   openpocket logs     xem log bridge
//   openpocket code     in mã ghép hiện tại (30 phút) + QR
//   openpocket autostart / watchdog / ensure — tự khởi động + máy canh
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeDataDir, loadConfig, saveConfig } from "../src/config.js";
import {
  AUTOSTART_TASK_NAME, WATCHDOG_TASK_NAME, bridgeEntryPath,
  buildTaskXml, writeTaskXml, buildTaskVbs, assessTaskXml,
  LOGON_TRIGGER_XML, WATCHDOG_TRIGGER_XML,
} from "../src/autostart.js";
import { loadTunnelState } from "../src/tunnel.js";
// Hình dạng link ghép (#p= / #t= / &m=) thuộc shared contract — CLI từng tự
// tay ghép ngoài contract (contract.js xưng "chỗ duy nhất" nhưng CLI sinh
// TRƯỚC contract). 07/10: kéo vào cùng một seam với bridge/web/worker.
import { buildPairingUrl } from "../../shared/contract.js";

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
            windowsHide: true,
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
  // Bridge đã chết — xóa sạch cả 3 file log (owner 13/09: log không giữ ở máy).
  const { deleteLogs } = await import("../src/logwipe.js");
  deleteLogs();
  console.log("🛑 Đã dừng bridge (log đã xóa sạch).");
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
  const config = loadConfig();
  if (config.lookupTenant) {
    console.log(`   Phòng: ${config.lookupTenant}${config.machineName ? ` (${config.machineName})` : ""}`);
  }
  // Trạng thái đường hầm (tunnel-state.json do bridge/src/tunnel.js ghi) —
  // đọc qua loadTunnelState của chính tunnel.js (một seam, hết tự tay
  // JSON.parse). Đang bị Cloudflare 429 thì nói rõ: đừng restart, càng
  // restart càng lâu.
  const st = loadTunnelState();
  if (st && st.phase === "backoff" && Number(st.nextAttemptAt) > Date.now()) {
    const mins = Math.ceil((Number(st.nextAttemptAt) - Date.now()) / 60_000);
    console.log(`   🚧 Tunnel: Cloudflare đang tạm chặn mở đường hầm (429) — tự thử lại sau ~${mins} phút.`);
    console.log("      ĐỪNG restart bridge — càng restart càng bị gia hạn. Điện thoại tự vào lại khi xong.");
  } else if (st && st.phase === "up" && st.url) {
    console.log(`   🌍 Tunnel: ${st.url}`);
  }
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

// ===== Tạo task bằng /XML — khuân nằm ở src/autostart.js (chân lý duy nhất)
// buildTaskXml / writeTaskXml / buildTaskVbs / assessTaskXml + 2 trigger XML
// import từ trên. Comment vì sao phải tạo bằng /XML (3 cờ chống-pin, sự cố
// 07/10) nằm ngay đầu phần đó trong src/autostart.js.

// Hỏi Task Scheduler: /xml khi hỏi được (export XML cần quyền đủ), rớt thì
// hỏi /query thường để ít nhất biết task còn tồn tại. Trả {exists, xml}.
function queryTask(taskName) {
  const xmlQ = spawnSync("schtasks", ["/Query", "/TN", taskName, "/xml"], { stdio: "pipe", encoding: "utf8", windowsHide: true });
  if (xmlQ.status === 0) return { exists: true, xml: xmlQ.stdout || "" };
  const plainQ = spawnSync("schtasks", ["/Query", "/TN", taskName], { stdio: "pipe", encoding: "utf8", windowsHide: true });
  return { exists: plainQ.status === 0, xml: "" };
}

// Trạng thái một task — assessTaskXml (src/autostart.js) là chỗ duy nhất
// quyết healthy/needsRepair; mỗi task kỳ vọng trigger riêng (autostart =
// LogonTrigger, watchdog = TimeTrigger 5 phút). XML không hỏi được (user
// thường) thì không dám khẳng định trigger sống: healthy/needsRepair = false,
// giữ thần tính bảo thủ như bản C# cũ.
function taskStatus(taskName, triggerTag) {
  const q = queryTask(taskName);
  const a = assessTaskXml(q.xml, triggerTag);
  return { exists: q.exists, healthy: q.exists && a.healthy, needsRepair: q.exists && a.needsRepair };
}

if (cmd === "tasks") {
  // Trạng thái CẢ HAI task dạng JSON — interface cho GUI desktop: một lần
  // spawn node thay vì GUI tự chạy schtasks rồi string-match XML (bản sao C#
  // đã xoá 07/10).
  console.log(JSON.stringify({
    autostart: taskStatus(AUTOSTART_TASK_NAME, "LogonTrigger"),
    watchdog: taskStatus(WATCHDOG_TASK_NAME, "TimeTrigger"),
  }));
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
  if (sub === "--run") {
    // Cho GUI: chạy task bridge CÓ SẴN (schtasks /run). --json để GUI parse
    // được exit + lời lỗi thay vì string-match tiếng người.
    const run = spawnSync("schtasks", ["/Run", "/TN", AUTOSTART_TASK_NAME], { stdio: "pipe", encoding: "utf8", windowsHide: true });
    const errText = run.status === 0 ? "" : ((run.stderr || run.stdout || "").trim() || `schtasks exit ${run.status}`);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ ok: run.status === 0, error: errText }));
      process.exit(0);
    }
    if (run.status !== 0) {
      console.log("Không chạy được task — mở terminal Run as Administrator rồi thử lại: " + errText);
      process.exit(1);
    }
    console.log("✅ Đã chạy task bridge.");
    process.exit(0);
  }
  if (sub === "--enable") {
    // /RL HIGHEST: bridge (và daemon điều khiển màn hình sinh ra từ nó) chạy
    // quyền admin — SendInput mới chạm được vào app đang chạy Administrator
    // (UIPI chặn input chiều thường -> admin). Đánh đổi: lệnh từ điện thoại
    // cũng mang quyền admin, bù bằng khóa thiết bị/phòng sẵn có.
    // Task chay qua wrapper VBS AN CUA SO (buildTaskVbs trong src/autostart.js;
    // GHI bằng writeFileSync "utf8" KHÔNG BOM — lý do nằm ở comment đó):
    // node trực tiếp sẽ có cửa sổ console đen - user đóng nhầm là bridge mất
    // log (đã gặp thật).
    const vbsPath = join(bridgeDataDir(), "bridge-task.vbs");
    writeFileSync(
      vbsPath,
      buildTaskVbs({
        nodeExecPath: process.execPath,
        entryPath: bridgeEntryPath(),
        logPath: join(bridgeDataDir(), "bridge-task.log"),
        workDir: join(BIN_DIR, ".."),
      }),
      "utf8"
    );
    const xmlPath = join(bridgeDataDir(), `${AUTOSTART_TASK_NAME}.task.xml`);
    writeTaskXml(xmlPath, buildTaskXml(LOGON_TRIGGER_XML, vbsPath));
    const created = spawnSync(
      "schtasks",
      ["/Create", "/TN", AUTOSTART_TASK_NAME, "/XML", xmlPath, "/F"],
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
  // --status (mặc định): task còn trong Scheduler không + trigger/cờ có lành
  // không (soi XML qua assessTaskXml — cùng chân lý với `tasks --json`).
  if (args.includes("--json")) {
    console.log(JSON.stringify(taskStatus(AUTOSTART_TASK_NAME, "LogonTrigger")));
    process.exit(0);
  }
  const st = taskStatus(AUTOSTART_TASK_NAME, "LogonTrigger");
  if (st.exists) {
    console.log(st.healthy
      ? `✅ Tự chạy đang BẬT (task "${AUTOSTART_TASK_NAME}" trong Task Scheduler).`
      : `⚠️ Task "${AUTOSTART_TASK_NAME}" còn nhưng trigger/cờ pin không lành — mở lại OpenPocket.exe là tự dựng lại (hoặc chạy: openpocket autostart --enable).`);
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
      buildTaskVbs({
        nodeExecPath: process.execPath,
        entryPath: self,
        logPath: join(bridgeDataDir(), "watchdog.log"),
        workDir: join(BIN_DIR, ".."),
        extraArgs: " ensure",
      }),
      "utf8"
    );
    const xmlPath = join(bridgeDataDir(), `${WATCHDOG_TASK_NAME}.task.xml`);
    writeTaskXml(xmlPath, buildTaskXml(WATCHDOG_TRIGGER_XML, vbsPath));
    const created = spawnSync(
      "schtasks",
      ["/Create", "/TN", WATCHDOG_TASK_NAME, "/XML", xmlPath, "/F"],
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

if (cmd === "code") {
  const { default: qrcode } = await import("../src/vendor/qrcode-terminal/index.js");
  const config = loadConfig();
  const port = config.port || 8788;
  const baseFixed = (config.lookupUrl || "").replace(/\/+$/, ""); // worker = địa chỉ cố định (ưu tiên)

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
  const pairUrl = buildPairingUrl({ base: pairBase, value: live.code, tenant: config.lookupTenant });
  const minutesLeft = live.secondsLeft != null ? Math.ceil(live.secondsLeft / 60) : null;

  console.log("");
  console.log(`📱 MÃ GHÉP (1 lần${minutesLeft != null ? `, còn ~${minutesLeft} phút` : ", sống 30 phút"}): ${live.codeFormatted}`);
  console.log(`🔗 Mở trên điện thoại: ${pairUrl}`);
  console.log("");
  console.log("QR ghép thiết bị — quét để vào:");
  qrcode.generate(pairUrl, { small: true });

  // 3) Mã vĩnh viễn — đọc từ config máy này (chỉ in tại máy, đừng chia sẻ).
  if (config.mobileToken) {
    const masterUrl = buildPairingUrl({
      base: baseFixed || `http://127.0.0.1:${port}`,
      kind: "master",
      value: config.mobileToken,
      tenant: config.lookupTenant,
    });
    console.log("");
    console.log("⭐ MÃ VĨNH VIỄN (không hết hạn, chỉ dùng tại máy — đừng chụp/chia sẻ):");
    console.log(`   ${config.mobileToken}`);
    console.log("");
    console.log("QR master — quét 1 lần, dùng mãi:");
    qrcode.generate(masterUrl, { small: true });
  }

  console.log("");
  console.log(`Địa chỉ cố định (bookmark 1 lần, dùng mãi): ${baseFixed || "chưa cấu hình"}`);
  process.exit(0);
}

console.log(`openpocket — điều khiển OpenWork Mobile bridge
Dùng:
  openpocket start    Chạy bridge nền (tự sinh mã, tunnel, heartbeat)
  openpocket stop     Dừng bridge
  openpocket status   Xem bridge có chạy không + phòng
  openpocket logs     Xem log (tail 50 dòng, Ctrl+C để thoát)
  openpocket code     Xem mã ghép + QR quét bằng điện thoại
  openpocket tasks --json   Trạng thái 2 task scheduler dạng JSON (GUI desktop dùng)
  openpocket autostart --enable [--with-openwork]   Tự chạy bridge khi đăng nhập Windows
  openpocket autostart --status                     Xem tự chạy đang bật hay tắt
  openpocket autostart --disable                    Tắt tự chạy
  openpocket watchdog --install   Máy canh: mỗi 5 phút tự dựng lại bridge nếu nó chết (cần admin 1 lần)
  openpocket watchdog --status    Xem máy canh bật hay tắt
  openpocket watchdog --uninstall Tắt máy canh
  openpocket ensure               Chạy thầm lặng: bridge sống thì thôi, chết thì dựng (lệnh của máy canh)`);
process.exit(0);
