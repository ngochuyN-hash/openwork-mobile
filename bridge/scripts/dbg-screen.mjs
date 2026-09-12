// Debug/live-test tính năng màn hình: chạy riêng, KHÔNG đụng bridge đang chạy.
//   node scripts/dbg-screen.mjs            -> daemon + move chuột + chụp 1 frame
//   node scripts/dbg-screen.mjs notepad    -> thêm: click + gõ tiếng Việt vào Notepad
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { ScreenService } from "../src/screen.js";

const cursor = () =>
  new Promise((res) =>
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
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
console.log("sau MOVE 0.5,0.5 (đợi 1440,900):", await cursor());
await s.input({ type: "move", x: 0.1, y: 0.1 });
console.log("sau MOVE 0.1,0.1 (đợi 288,180):", await cursor());

// Chụp 1 frame bằng đúng pipeline của vòng stream
const img = s.monitor.ref.captureImageSync();
const sharp = (await import("sharp")).default;
const jpeg = await sharp(img.toRawSync(), { raw: { width: img.width, height: img.height, channels: 4 } })
  .resize({ width: 880, withoutEnlargement: true })
  .jpeg({ quality: 55 })
  .toBuffer();
await writeFile("tmp-screen.jpg", jpeg);
console.log("frame chụp xong: tmp-screen.jpg", (jpeg.length / 1024).toFixed(0), "KB");

if (process.argv[2] === "notepad") {
  await s.input({ type: "click", x: 0.5, y: 0.5 });
  console.log("CLICK giữa màn hình xong");
  await new Promise((r) => setTimeout(r, 300));
  await s.input({ type: "text", text: "Xin chào OpenWork từ điện thoại!" });
  console.log("TEXT tiếng Việt xong");
  await s.input({ type: "key", key: "enter" });
  console.log("KEY enter xong");
}
process.exit(0);
