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

rem Sinh src\IdentityKeys.cs tu shared\identity-keys.txt - whitelist 4 key dinh
rem danh may, NGUON DUY NHAT cung la noi bridge/src/identity.js doc luc chay
rem (candidate 2, review 07/10). GUI va bridge khong the troi khoi nhau: them
rem key = sua file txt do, build lai exe la ca 2 ben thay doi.
> src\IdentityKeys.cs echo // Sinh tu dong boi build.bat tu shared\identity-keys.txt - KHONG sua tay, KHONG commit.
>> src\IdentityKeys.cs echo internal static class IdentityKeys
>> src\IdentityKeys.cs echo {
>> src\IdentityKeys.cs echo     public static readonly string[] All = new string[]
>> src\IdentityKeys.cs echo     {
for /f "usebackq eol=# delims=" %%k in ("%~dp0..\shared\identity-keys.txt") do >> src\IdentityKeys.cs echo         "%%k",
>> src\IdentityKeys.cs echo     };
>> src\IdentityKeys.cs echo }

rem Sinh src\HostContract.cs tu shared\host-contract.js (candidate 1, review
rem 07/10): kien thuc host (port, thu muc, ten log, pid, ten task, key config,
rem shape tunnel) mot nguon — JS import ban goc, C# nhan ban sinh ra. Thieu
rem file sinh ra la compile dut vi cac module C# dan sang dung HostContract.*.
node "%~dp0gen-host-contract.mjs"
if not exist "src\HostContract.cs" (
    echo [ERROR] Khong sinh duoc src\HostContract.cs - can node.exe tren may build
    exit /b 1
)

echo Compiling OpenPocket.exe...
rem 8 module (tách candidate 7 06/10): Ui + BridgeConfig + BridgeProcess +
rem TunnelState + AutostartTask + BridgeHttp + Provisioning + PairingQrDialog,
rem OpenPocket.cs chỉ còn form chính + điều phối.
"%CSC%" /target:winexe /optimize /codepage:65001 /win32manifest:src\app.manifest /win32icon:src\app.ico /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:System.Management.dll /out:bin\OpenPocket.exe src\InviteKey.cs src\IdentityKeys.cs src\HostContract.cs src\Ui.cs src\BridgeConfig.cs src\BridgeProcess.cs src\TunnelState.cs src\AutostartTask.cs src\BridgeHttp.cs src\Provisioning.cs src\PairingQrDialog.cs src\OpenPocket.cs

if %ERRORLEVEL% equ 0 (
    echo [OK] Bien dich thanh cong: desktop\bin\OpenPocket.exe
) else (
    echo [ERROR] Bien dich that bai!
    exit /b %ERRORLEVEL%
)
