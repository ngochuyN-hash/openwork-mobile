@echo off
rem Swap GUI OpenPocket sang ban build moi — chay ELEVATED (UAC) vi GUI cu
rem requireAdministrator, shell thuong khong kill duoc.
taskkill /f /im OpenPocket.exe
timeout /t 1 /nobreak >nul
start "" "%~dp0bin\OpenPocket.exe"
