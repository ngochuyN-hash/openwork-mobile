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

rem Sinh src\WorkerUrl.cs tu worker.url — y het build.bat. Thieu file thi
rem placeholder, dung de smoke-test ma nhung khong tro ve may chu.
set WORKER_URL=
if exist "worker.url" set /p WORKER_URL=<worker.url
if not defined WORKER_URL set WORKER_URL=https://YOUR-WORKER.workers.dev
> src\WorkerUrl.cs echo // Sinh tu dong boi build-test.bat tu worker.url (gitignored) - KHONG sua tay, KHONG commit.
>> src\WorkerUrl.cs echo internal static class WorkerUrl
>> src\WorkerUrl.cs echo {
>> src\WorkerUrl.cs echo     public const string Value = "%WORKER_URL%";
>> src\WorkerUrl.cs echo }

rem Sinh src\IdentityKeys.cs tu shared\identity-keys.txt - y het build.bat
rem (candidate 2, review 07/10): whitelist 4 key dinh danh may, mot nguoi dung.
> src\IdentityKeys.cs echo // Sinh tu dong boi build-test.bat tu shared\identity-keys.txt - KHONG sua tay, KHONG commit.
>> src\IdentityKeys.cs echo internal static class IdentityKeys
>> src\IdentityKeys.cs echo {
>> src\IdentityKeys.cs echo     public static readonly string[] All = new string[]
>> src\IdentityKeys.cs echo     {
for /f "usebackq eol=# delims=" %%k in ("%~dp0..\shared\identity-keys.txt") do >> src\IdentityKeys.cs echo         "%%k",
>> src\IdentityKeys.cs echo     };
>> src\IdentityKeys.cs echo }

rem Sinh src\HostContract.cs tu shared\host-contract.js - y het build.bat
rem (candidate 1, review 07/10): kien thuc host mot nguon, C# nhan ban sinh ra.
node "%~dp0gen-host-contract.mjs"
if not exist "src\HostContract.cs" (
    echo [ERROR] Khong sinh duoc src\HostContract.cs - can node.exe tren may build
    exit /b 1
)

"%CSC%" /target:winexe /optimize /codepage:65001 /win32icon:src\app.ico /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:System.Management.dll /out:bin\OpenPocket-test.exe src\InviteKey.cs src\WorkerUrl.cs src\IdentityKeys.cs src\HostContract.cs src\ErrorCode.cs src\Ui.cs src\BridgeConfig.cs src\BridgeProcess.cs src\TunnelState.cs src\AutostartTask.cs src\BridgeHttp.cs src\Provisioning.cs src\PairingQrDialog.cs src\OpenPocket.cs
if %ERRORLEVEL% equ 0 (
    echo [OK] Bien dich thanh cong: desktop\bin\OpenPocket-test.exe
) else (
    echo [ERROR] Bien dich that bai!
    exit /b %ERRORLEVEL%
)
