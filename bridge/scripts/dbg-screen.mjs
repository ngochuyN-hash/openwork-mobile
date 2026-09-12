// Debug/live-test tính năng màn hình: chạy riêng, KHÔNG đụng bridge đang chạy.
//   node scripts/dbg-screen.mjs            -> daemon + move chuột + chụp 1 frame
//   node scripts/dbg-screen.mjs notepad    -> mở Notepad, click + gõ tiếng Việt,
//                                             xác nhận qua title bị đánh dấu dirty
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { ScreenService } from "../src/screen.js";

const PS = ["-NoProfile", "-ExecutionPolicy", "Bypass"];

// pid | tên process | rect | title của cửa sổ FOREGROUND hiện tại
async function fgInfo() {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public struct RECT { public int L, T, R, B; }
}
"@
$h = [FG]::GetForegroundWindow()
$pid2 = 0
[FG]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
$r = New-Object FG+RECT
[FG]::GetWindowRect($h, [ref]$r) | Out-Null
$sb = New-Object System.Text.StringBuilder 512
[FG]::GetWindowText($h, $sb, 512) | Out-Null
$proc = (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName
Write-Output "$pid2|$proc|$($r.L),$($r.T),$($r.R),$($r.B)|$($sb.ToString())"
`;
  await writeFile("tmp-fg.ps1", `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n${script}`, "utf8");
  return new Promise((res) =>
    execFile("powershell", [...PS, "-File", "tmp-fg.ps1"], { windowsHide: true, timeout: 20_000 }, (e, o) =>
      res(String(o ?? "").trim())
    )
  );
}

const cursor = () =>
  new Promise((res) =>
    execFile(
      "powershell",
      [...PS, "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output (\"$($p.X),$($p.Y)\")"],
      { windowsHide: true, timeout: 15_000 },
      (e, o) => res(String(o).trim())
    )
  );

const s = new ScreenService();
await s.ensureMonitor();
console.log("monitor:", JSON.stringify(s.dims()));
const t0 = Date.now();
await s.ensureDaemon();
console.log("daemon compiled+pinged:", Date.now() - t0, "ms");
console.log("cursor trước:", await cursor());

await s.input({ type: "move", x: 0.5, y: 0.5 });
console.log("sau MOVE 0.5,0.5 (đợi 1440,900 vật lý):", await cursor());

if (process.argv[2] === "notepad") {
  const dims = s.dims();
  const notepad = spawn("notepad.exe", [], { detached: true, stdio: "ignore", windowsHide: false });
  notepad.unref();
  await new Promise((r) => setTimeout(r, 2500));

  // Notepad spawned từ nền không tự chiếm focus — mẹo chuẩn: nhấn ALT (mở khóa
  // foreground-lock của Windows) rồi SetForegroundWindow.
  await new Promise((res) =>
    execFile(
      "powershell",
      [...PS, "-Command",
        "$sig = '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);'; Add-Type -MemberDefinition $sig -Name U -Namespace W; $np = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($np) { [W.U]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W.U]::SetForegroundWindow($np.MainWindowHandle) | Out-Null; [W.U]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 600; Write-Output \"pid=$($np.Id) fg=$([W.U]::GetForegroundWindow()) np=$($np.MainWindowHandle)\" } else { Write-Output 'no-notepad' }"],
      { windowsHide: true, timeout: 15_000 },
      (e, o) => { console.log("kích hoạt notepad:", String(o ?? "").trim()); res(); }
    )
  );

  const fg = await fgInfo();
  const [fgPid, fgProc, rect, title] = fg.split("|");
  console.log("foreground:", fgPid, fgProc, rect, JSON.stringify(title));
  if (fgProc.toLowerCase() !== "notepad") {
    console.log("!! Notepad KHÔNG phải cửa sổ focus — KHÔNG gõ bừa, dừng test an toàn.");
    process.exit(1);
  }

  // Click đúng tâm cửa sổ Notepad (đổi pixel -> chuẩn hóa 0..1)
  const [L, T, R, B] = rect.split(",").map(Number);
  const nx = ((L + R) / 2) / dims.width;
  const ny = Math.min(0.95, ((T + B) / 2 + 60) / dims.height); // lệch xuống dưới tránh thanh title
  await s.input({ type: "click", x: nx, y: ny });
  console.log(`CLICK tâm Notepad (${nx.toFixed(3)},${ny.toFixed(3)}) xong`);
  await new Promise((r) => setTimeout(r, 400));

  await s.input({ type: "text", text: "Xin chào OpenWork từ điện thoại!" });
  console.log("TEXT tiếng Việt xong");
  await s.input({ type: "key", key: "enter" });
  console.log("KEY enter xong");
  await new Promise((r) => setTimeout(r, 400));

  const fg2 = await fgInfo();
  console.log("foreground sau khi gõ:", fg2);
  const title2 = fg2.split("|")[3] ?? "";
  if (/^[•*]/.test(title2) || (title !== title2 && title2)) {
    console.log("==> KẾT QUẢ: Notepad nhận được phím (title chuyển dirty:", JSON.stringify(title2) + ")");
  } else {
    console.log("==> KẾT QUẢ: chưa chắc chắn — title không đổi:", JSON.stringify(title2));
  }

  // Trả focus về cửa sổ trước đó (thief lịch sự) + đóng Notepad của test (theo pid)
  await new Promise((res) =>
    execFile(
      "powershell",
      [...PS, "-Command",
        `$sig = '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);'; Add-Type -MemberDefinition $sig -Name U2 -Namespace W2; $p = Get-Process -Id ${fgPid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [W2.U2]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Write-Output 'restored' }; Stop-Process -Id ${fgPid} -Force -ErrorAction SilentlyContinue; Write-Output 'closed-notepad'`],
      { windowsHide: true, timeout: 15_000 },
      (e, o) => { console.log("trả focus + đóng notepad test:", String(o ?? "").trim().replace(/\n/g, " ")); res(); }
    )
  );
}
process.exit(0);
