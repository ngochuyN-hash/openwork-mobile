@echo off
rem Cai dat bridge cho ban be: double-click file nay trong thu muc bridge
rem (can Node.js 20+ da cai san - tai https://nodejs.org ban LTS)
title OpenPocket - Cai dat cau noi (1 lan duy nhat)
cd /d "%~dp0"
echo.
echo === OpenPocket: dang cai dat thu vien (lan dau mat 1-3 phut) ===
call npm install
if errorlevel 1 (
    echo.
    echo [LOI] npm install that bai - ban da cai Node.js 20+ chua? Tai: https://nodejs.org
    pause
    exit /b 1
)
echo.
echo === Dang tao lenh "openpocket" toan cuc ===
call npm link
if errorlevel 1 (
    echo.
    echo [LOI] npm link that bai - hay chay file nay bang quyen Administrator.
    pause
    exit /b 1
)
echo.
echo === XONG! ===
echo Gio hay mo OpenPocket.exe o thu muc ben cạnh,
echo dan LINK MOI vao tab "May cua toi" roi bam "Luu cau hinh".
echo.
pause
