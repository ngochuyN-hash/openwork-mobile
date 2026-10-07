import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { HOST_CONTRACT } from "../../shared/host-contract.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// Tên task trong Task Scheduler. Export để unit test + dùng chung với
// bin/openpocket.js. Nguồn là shared/host-contract.js — GUI C# nhận bản sinh
// ra từ cùng file đó, hai bên không thể trôi khỏi nhau.
export const AUTOSTART_TASK_NAME = HOST_CONTRACT.autostartTaskName;
// Task máy canh (5 phút/lần chạy `openpocket ensure`) — bridge chết ngầm là
// tự hồi sinh, khỏi đợi reboot hay ai đó mở tay.
export const WATCHDOG_TASK_NAME = HOST_CONTRACT.watchdogTaskName;

export function bridgeEntryPath() {
  return join(SRC_DIR, "index.js");
}

// ===== KHUÂN TASK SCHEDULER — CHÂN LÝ DUY NHẤT (CLI + GUI cùng dùng) =======
// GUI desktop (desktop/src/AutostartTask.cs) KHÔNG tự dựng XML/VBS nữa — nó
// shell-out qua `openpocket tasks/autostart/watchdog`. Trước 07/10 template
// tồn tại hai bản sao (C# + JS) hàn bằng comment "giữ 2 bên khớp", cả hai đều
// 0 test, trong khi đây là đúng logic từng gây sự cố thật: schtasks /Create
// mặc định DisallowStartIfOnBatteries=true + StopIfGoingOnBatteries=true +
// StartWhenAvailable=false — laptop chạy pin là task bị SKIP im lặng (bắt
// gặp thật 07/10: logon-trigger không chạy, /run kẹt Queued chờ AC, watchdog
// bị tính missed). Tạo bằng /XML ép 3 cờ ngược lại: chạy được khi pin, không
// tự chết khi rút sạc, lỡ nhịp thì chạy bù. Khuôn bắt chước y XML schtasks
// tự sinh (đã verify trên máy thật).

export function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const LOGON_TRIGGER_XML = `    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>`;

export const WATCHDOG_TRIGGER_XML = `    <TimeTrigger>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <Enabled>true</Enabled>
      <StartBoundary>2020-01-01T00:00:00</StartBoundary>
    </TimeTrigger>`;

export function buildTaskXml(triggerXml, vbsPath) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
  </Settings>
  <Triggers>
${triggerXml}
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${xmlEscape(vbsPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// schtasks đọc /XML theo declaration — ghi UTF-16LE kèm BOM cho khớp chuẩn.
export function writeTaskXml(xmlPath, xml) {
  writeFileSync(xmlPath, "\ufeff" + xml, "utf16le");
}

// Nội dung .vbs chạy ẩn cửa sổ + gom log. Việc GHI phải là "utf8" KHÔNG BOM
// (writeFileSync "utf8" mặc định không BOM): wscript đọc .vbs dính UTF-8 BOM
// là chết ngay với lỗi "Not enough memory resources" — task Running ảo,
// bridge không bao giờ boot (bắt gặp thật 13/09). extraArgs: " ensure" cho
// task watchdog.
export function buildTaskVbs({ nodeExecPath, entryPath, logPath, workDir, extraArgs = "" }) {
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${workDir}"`,
    `sh.Run "cmd /c """""${nodeExecPath}"" ""${entryPath}""${extraArgs} >> ""${logPath}" 2>&1""", 0, False`,
  ].join("\r\n") + "\r\n";
}

// Soi XML của task (từ `schtasks /query /tn X /xml`) — một chỗ duy nhất cho
// Healthy/NeedsRepair, GUI đọc kết quả qua `openpocket tasks --json`.
// triggerTag: autostart kỳ vọng LogonTrigger, watchdog kỳ vọng TimeTrigger
// (5 phút/lần) — soi nhầm loại là watchdog sẽ "không lành" vĩnh viễn.
export function assessTaskXml(xml, triggerTag = "LogonTrigger") {
  if (!xml) return { exists: false, healthy: false, needsRepair: false };
  const healthy = xml.includes(triggerTag);
  const needsRepair = !healthy
    || xml.includes("<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>")
    || xml.includes("<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>");
  return { exists: true, healthy, needsRepair };
}
