@echo off
setlocal
cd /d "%~dp0"

set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" (
    set CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe
)

if not exist "%CSC%" (
    echo [ERROR] Khong tim thay csc.exe .NET Framework
    exit /b 1
)

if not exist "bin" mkdir "bin"

rem Sinh src\InviteKey.cs tu invite.key (gitignored, may chu worker) - ma moi
rem nhung vao exe. Thieu invite.key thi exe van build duoc nhung KHONG co ma:
rem worker se tu choi tao phong (403 invite_required).
set INVITE_KEY=
if exist "invite.key" set /p INVITE_KEY=<invite.key
> src\InviteKey.cs echo // Sinh tu dong boi build.bat tu invite.key (gitignored) - KHONG sua tay, KHONG commit.
>> src\InviteKey.cs echo internal static class InviteConfig
>> src\InviteKey.cs echo {
>> src\InviteKey.cs echo     public const string RoomInviteKey = "%INVITE_KEY%";
>> src\InviteKey.cs echo }
if not defined INVITE_KEY echo [WARN] Thieu invite.key - exe nay se KHONG tu tao duoc phong tren worker.

echo Compiling OpenPocket.exe...
"%CSC%" /target:winexe /optimize /codepage:65001 /win32manifest:src\app.manifest /win32icon:src\app.ico /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:System.Management.dll /out:bin\OpenPocket.exe src\InviteKey.cs src\OpenPocket.cs

if %ERRORLEVEL% equ 0 (
    echo [OK] Bien dich thanh cong: desktop\bin\OpenPocket.exe
) else (
    echo [ERROR] Bien dich that bai!
    exit /b %ERRORLEVEL%
)
