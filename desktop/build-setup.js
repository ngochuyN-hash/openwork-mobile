// Build bộ cài OpenPocket — MỘT file OpenPocket-Setup.exe.
//
// Chuỗi: stage (bridge + web/dist + OpenPocket.exe + HUONG-DAN) → zip →
// NHÚNG zip vào exe trình cài (desktop/src/OpenPocketSetup.cs, csc /res:) →
// OpenPocket-Setup.exe ở gốc dự án.
//
// Chạy: node desktop/build-setup.js
// Yêu cầu: đã build desktop/bin/OpenPocket.exe trước (desktop\build.bat).

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const STAGE = path.join(process.env.TEMP, "openpocket-sfx-stage");
const ZIP = path.join(process.env.TEMP, "openpocket-package.zip");
const OUT_EXE = path.join(ROOT, "OpenPocket-Setup.exe");

// 1. Stage — bố cục đúng như app đòi (OpenPocket.exe nằm cạnh bridge\, web\)
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, "bridge"), { recursive: true });
fs.mkdirSync(path.join(STAGE, "web"), { recursive: true });
fs.cpSync(path.join(ROOT, "bridge", "src"), path.join(STAGE, "bridge", "src"), { recursive: true });
fs.cpSync(path.join(ROOT, "bridge", "bin"), path.join(STAGE, "bridge", "bin"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "bridge", "package.json"), path.join(STAGE, "bridge", "package.json"));
fs.copyFileSync(path.join(ROOT, "bridge", "package-lock.json"), path.join(STAGE, "bridge", "package-lock.json"));
fs.cpSync(path.join(ROOT, "web", "dist"), path.join(STAGE, "web", "dist"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "desktop", "bin", "OpenPocket.exe"), path.join(STAGE, "OpenPocket.exe"));
fs.copyFileSync(path.join(ROOT, "HUONG-DAN.txt"), path.join(STAGE, "HUONG-DAN.txt"));

// 2. Zip (Compress-Archive mangled tên có dấu — mọi entry giữ ASCII, đã vậy)
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${ZIP}' -Force"`,
  { stdio: "inherit" }
);

// 3. Nhúng zip vào exe trình cài bằng csc có sẵn trong Windows
const csc64 = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const csc32 = "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe";
const csc = fs.existsSync(csc64) ? csc64 : csc32;
const args = [
  "/target:winexe",
  "/optimize",
  "/codepage:65001",
  `/win32manifest:${path.join(ROOT, "desktop", "src", "setup.manifest")}`,
  "/r:System.dll",
  "/r:System.Drawing.dll",
  "/r:System.Windows.Forms.dll",
  "/r:System.IO.Compression.dll",
  "/r:System.IO.Compression.FileSystem.dll",
  "/r:Microsoft.CSharp.dll",
  `/res:${ZIP}`,
  `/out:${OUT_EXE}`,
  path.join(ROOT, "desktop", "src", "OpenPocketSetup.cs"),
];
const build = spawnSync(csc, args, { encoding: "utf8" });
if (build.error) throw build.error;
if (build.status !== 0) {
  console.error(build.stdout);
  console.error(build.stderr);
  process.exit(build.status || 1);
}

console.log("OpenPocket-Setup.exe:", (fs.statSync(OUT_EXE).size / 1024).toFixed(0) + " KB");
