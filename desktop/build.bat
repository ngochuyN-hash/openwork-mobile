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

echo Compiling OpenPocket.exe...
"%CSC%" /target:winexe /optimize /codepage:65001 /win32manifest:src\app.manifest /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:System.Management.dll /out:bin\OpenPocket.exe src\OpenPocket.cs

if %ERRORLEVEL% equ 0 (
    echo [OK] Bien dich thanh cong: desktop\bin\OpenPocket.exe
) else (
    echo [ERROR] Bien dich that bai!
    exit /b %ERRORLEVEL%
)
