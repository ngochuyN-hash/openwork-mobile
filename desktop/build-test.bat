@echo off
rem Build ban TEST khong manifest admin (asInvoker) — chay duoc tu shell thuong,
rem dung de xem truoc UI khi ban chinh (requireAdministrator) can UAC de restart.
setlocal
cd /d "%~dp0"
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
    echo [ERROR] Khong tim thay csc.exe .NET Framework
    exit /b 1
)
rem Sinh src\InviteKey.cs tu invite.key — y het build.bat (xem phan gan duoi).
set INVITE_KEY=
if exist "invite.key" set /p INVITE_KEY=<invite.key
> src\InviteKey.cs echo // Sinh tu dong boi build-test.bat tu invite.key (gitignored) - KHONG sua tay, KHONG commit.
>> src\InviteKey.cs echo internal static class InviteConfig
>> src\InviteKey.cs echo {
>> src\InviteKey.cs echo     public const string RoomInviteKey = "%INVITE_KEY%";
>> src\InviteKey.cs echo }

"%CSC%" /target:winexe /optimize /codepage:65001 /win32icon:src\app.ico /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:System.Management.dll /out:bin\OpenPocket-test.exe src\InviteKey.cs src\Ui.cs src\BridgeConfig.cs src\BridgeProcess.cs src\TunnelState.cs src\AutostartTask.cs src\BridgeHttp.cs src\Provisioning.cs src\PairingQrDialog.cs src\OpenPocket.cs
if %ERRORLEVEL% equ 0 (
    echo [OK] Bien dich thanh cong: desktop\bin\OpenPocket-test.exe
) else (
    echo [ERROR] Bien dich that bai!
    exit /b %ERRORLEVEL%
)
