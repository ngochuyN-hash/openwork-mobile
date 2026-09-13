const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Build OpenPocket-Setup.cmd — a ONE-FILE installer (self-extracting batch).
// Layout: batch header (fixed line count matters NOT — we locate the payload
// by marker with findstr) + marker + base64'd zip of the stage dir.

// 1. Stage -> zip (ASCII entry names only, Compress-Archive would mangle diacritics)
const ROOT = "C:\\Antigravity\\Openwork Mobile App";
const STAGE = "C:\\Users\\user\\AppData\\Local\\Temp\\openpocket-sfx-stage";
const ZIP = "C:\\Users\\user\\AppData\\Local\\Temp\\openpocket-package.zip";
const OUT = process.argv[2] || "C:\\Users\\user\\AppData\\Local\\Temp\\OpenPocket-Setup.cmd";

execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${ZIP}' -Force"`,
  { stdio: "inherit" }
);

// 2. zip -> base64, wrapped at 64 cols (certutil-friendly)
const raw = fs.readFileSync(ZIP);
const b64 = raw.toString("base64").replace(/(.{64})/g, "$1\n");

// 3. header (ASCII only) + marker + payload
let hdr = "";
hdr += "@echo off\r\n";
hdr += "setlocal\r\n";
hdr += "title OpenPocket Setup\r\n";
hdr += "set \"WORK=%TEMP%\\openpocket-setup-%RANDOM%\"\r\n";
hdr += "mkdir \"%WORK%\" >nul 2>nul\r\n";
hdr += "set \"SCRIPT=%~f0\"\r\n";
hdr += "for /f \"delims=:\" %%L in ('findstr /n /b \";__PAYLOAD_BELOW__\" \"%SCRIPT%\"') do set \"SKIP=%%L\"\r\n";
hdr += "more +%SKIP% \"%SCRIPT%\" > \"%WORK%\\payload.b64\"\r\n";
hdr += "certutil -f -decode \"%WORK%\\payload.b64\" \"%WORK%\\OpenPocket.zip\" >nul 2>nul\r\n";
hdr += "if errorlevel 1 goto :broken\r\n";
hdr += "powershell -NoProfile -Command \"Expand-Archive -Force '%WORK%\\OpenPocket.zip' '%WORK%'\" >nul 2>nul\r\n";
hdr += "if not exist \"%WORK%\\OpenPocket.exe\" goto :broken\r\n";
hdr += "set \"FINAL=%LOCALAPPDATA%\\OpenPocket\"\r\n";
hdr += "if not \"%OPENPOCKET_TEST_DIR%\"==\"\" set \"FINAL=%OPENPOCKET_TEST_DIR%\"\r\n";
hdr += "where node >nul 2>nul\r\n";
hdr += "if errorlevel 1 (\r\n";
hdr += "  start \"\" https://nodejs.org\r\n";
hdr += "  mshta \"javascript:var sh=new ActiveXObject('WScript.Shell');sh.Popup('Chua co Node.js! Trinh duyet vua mo trang tai Node.js (ban LTS). Cai xong hay chay lai file Setup nay.',0,'OpenPocket',64);close();\"\r\n";
hdr += "  goto :cleanup\r\n";
hdr += ")\r\n";
hdr += "if not exist \"%FINAL%\" mkdir \"%FINAL%\" >nul 2>nul\r\n";
hdr += "xcopy /E /I /Y /Q \"%WORK%\\bridge\" \"%FINAL%\\bridge\" >nul 2>nul\r\n";
hdr += "xcopy /E /I /Y /Q \"%WORK%\\web\" \"%FINAL%\\web\" >nul 2>nul\r\n";
hdr += "copy /Y \"%WORK%\\OpenPocket.exe\" \"%FINAL%\\\" >nul 2>nul\r\n";
hdr += "copy /Y \"%WORK%\\HUONG-DAN.txt\" \"%FINAL%\\\" >nul 2>nul\r\n";
hdr += "powershell -NoProfile -Command \"$ws=New-Object -ComObject WScript.Shell; $p='%FINAL%\\OpenPocket.exe'; $lnk=$ws.CreateShortcut([Environment]::GetFolderPath('Programs')+'\\OpenPocket.lnk'); $lnk.TargetPath=$p; $lnk.Save(); $lnk2=$ws.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\OpenPocket.lnk'); $lnk2.TargetPath=$p; $lnk2.Save()\" >nul 2>nul\r\n";
hdr += "echo Da cai OpenPocket xong vao: %FINAL%\r\n";
hdr += "echo Dang mo app... (UAC hoi thi bam Yes)\r\n";
hdr += "if \"%OPENPOCKET_TEST_DIR%\"==\"\" start \"\" \"%FINAL%\\OpenPocket.exe\"\r\n";
hdr += "goto :cleanup\r\n";
hdr += ":broken\r\n";
hdr += "echo File Setup bi loi (tai chua du?) - tai lai va thu lai nhe.\r\n";
hdr += "pause\r\n";
hdr += "goto :eof\r\n";
hdr += ":cleanup\r\n";
hdr += "rd /s /q \"%WORK%\" >nul 2>nul\r\n";
hdr += "exit /b 0\r\n";
hdr += ";__PAYLOAD_BELOW__\r\n";

fs.writeFileSync(OUT, hdr + b64 + "\r\n", "utf8");
console.log("Setup written:", OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + " KB");
