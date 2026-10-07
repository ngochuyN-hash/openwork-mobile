// Khuân Task Scheduler nằm ở src/autostart.js — CHÂN LÝ DUY NHẤT từ 07/10
// (GUI desktop shell-out qua CLI, hết bản sao C#). Đây là logic từng gây sự
// cố thật (máy đang pin → task bị schtasks skip im lặng) mà trước đây 0 test
// ở CẢ HAI ngôn ngữ — giờ ghim ở đây: 3 cờ chống-pin, RunLevel, escape XML,
// UTF-16 BOM cho /Create /XML, VBS không dính BOM khi ghi, và bộ đánh giá
// healthy/needsRepair mà GUI đọc qua `openpocket tasks --json`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTaskXml, writeTaskXml, buildTaskVbs, assessTaskXml,
  LOGON_TRIGGER_XML, WATCHDOG_TRIGGER_XML,
} from "../src/autostart.js";

test("task XML ép đủ 3 cờ chống-pin + RunLevel cao + escape đường dẫn", () => {
  const xml = buildTaskXml(LOGON_TRIGGER_XML, "C:\\dir with & space\\bridge-task.vbs");
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<RunLevel>HighestAvailable<\/RunLevel>/);
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.ok(xml.includes("C:\\dir with &amp; space\\bridge-task.vbs"), "vbsPath phải được xml-escape");
});

test("watchdog trigger lặp 5 phút", () => {
  assert.match(WATCHDOG_TRIGGER_XML, /<Interval>PT5M<\/Interval>/);
  assert.match(WATCHDOG_TRIGGER_XML, /<StartBoundary>/);
});

test("writeTaskXml ghi UTF-16LE mở đầu bằng BOM (schtasks đọc theo chuẩn)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ow-taskxml-"));
  try {
    const p = join(dir, "t.task.xml");
    writeTaskXml(p, buildTaskXml(LOGON_TRIGGER_XML, "x.vbs"));
    const buf = readFileSync(p);
    assert.deepEqual([...buf.slice(0, 2)], [0xff, 0xfe], "2 byte đầu phải là BOM UTF-16LE FF FE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VBS wrapper: bọc ngoặc kép chuẩn cho đường dẫn có dấu cách", () => {
  const vbs = buildTaskVbs({
    nodeExecPath: "C:\\Program Files\\node.exe",
    entryPath: "C:\\repo\\src\\index.js",
    logPath: "C:\\data dir\\bridge-task.log",
    workDir: "C:\\repo",
  });
  assert.ok(vbs.startsWith('Set sh = CreateObject("WScript.Shell")\r\n'));
  assert.ok(vbs.includes('sh.CurrentDirectory = "C:\\repo"'));
  assert.ok(
    vbs.includes('sh.Run "cmd /c """"C:\\Program Files\\node.exe"" ""C:\\repo\\src\\index.js"" >> ""C:\\data dir\\bridge-task.log"" 2>&1""", 0, False'),
    "dòng sh.Run phải đúng khuôn đã chạy thật (khuôn 5 nháy là VBScript compile error 800A04...)"
  );
  assert.ok(vbs.endsWith("\r\n"));
});

test("VBS watchdog nhánh ensure: entry + ' ensure' trước redirect log", () => {
  const vbs = buildTaskVbs({
    nodeExecPath: "C:\\n\\node.exe",
    entryPath: "C:\\repo\\bridge\\bin\\openpocket.js",
    logPath: "C:\\d\\watchdog.log",
    workDir: "C:\\repo",
    extraArgs: " ensure",
  });
  assert.ok(
    vbs.includes('""C:\\repo\\bridge\\bin\\openpocket.js"" ensure >> ""C:\\d\\watchdog.log"'),
    "watchdog phải chạy openpocket ensure"
  );
});

test("assessTaskXml: healthy/needsRepair theo trigger + cờ pin", () => {
  const good = buildTaskXml(LOGON_TRIGGER_XML, "x.vbs");
  assert.deepEqual(assessTaskXml(good), { exists: true, healthy: true, needsRepair: false });

  // Sự cố 07/10: task tồn tại nhưng mang cờ mặc định của schtasks — cần repair.
  const batteryHostile = good
    .replace("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
             "<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>");
  const a = assessTaskXml(batteryHostile);
  assert.equal(a.exists, true);
  assert.equal(a.needsRepair, true);

  // Trigger chết (không phải LogonTrigger) — cũng cần repair.
  const noTrigger = buildTaskXml(WATCHDOG_TRIGGER_XML, "x.vbs");
  assert.equal(assessTaskXml(noTrigger).healthy, false);
  assert.equal(assessTaskXml(noTrigger).needsRepair, true);

  // Watchdog kỳ vọng TimeTrigger: task watchdog lành phải đánh giá theo
  // đúng loại trigger của nó (soi LogonTrigger là "không lành" vĩnh viễn).
  assert.deepEqual(assessTaskXml(noTrigger, "TimeTrigger"),
    { exists: true, healthy: true, needsRepair: false });

  // XML không hỏi được (thiếu quyền, task không tồn tại) — bảo thủ như C# cũ.
  assert.deepEqual(assessTaskXml(""), { exists: false, healthy: false, needsRepair: false });
});
