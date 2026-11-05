@echo off
setlocal EnableExtensions
title Kasho Installer
color 0E
set "OWNER=a7med7uss"
set "REPO=shop_system"
set "ASSET=Kasho-Setup.exe"
set "HASH_ASSET=Kasho-Setup.exe.sha256"
set "TEMP_DIR=%TEMP%\KashoInstaller"
set "INSTALLER=%TEMP_DIR%\%ASSET%"
set "HASH_FILE=%TEMP_DIR%\%HASH_ASSET%"
echo.
echo  ==============================================
echo                  KASHO INSTALLER
echo        Scan. Sell. Done.  -  كاشو
echo  ==============================================
echo.
if not "%PROCESSOR_ARCHITECTURE%"=="AMD64" if not "%PROCESSOR_ARCHITEW6432%"=="AMD64" (
  echo  ERROR: Kasho currently supports 64-bit Windows only.
  pause
  exit /b 1
)
where powershell >nul 2>nul
if errorlevel 1 (
  echo  ERROR: Windows PowerShell is required.
  pause
  exit /b 1
)
if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%" >nul 2>nul
echo  [1/4] Downloading the latest Kasho release...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; $r=Invoke-RestMethod -Uri 'https://api.github.com/repos/%OWNER%/%REPO%/releases/latest' -Headers @{'User-Agent'='Kasho-Installer'}; $a=$r.assets | Where-Object {$_.name -eq '%ASSET%'} | Select-Object -First 1; $h=$r.assets | Where-Object {$_.name -eq '%HASH_ASSET%'} | Select-Object -First 1; if(-not $a -or -not $h){throw 'Kasho installer/checksum is missing from the latest release.'}; Invoke-WebRequest -Uri $a.browser_download_url -OutFile '%INSTALLER%' -Headers @{'User-Agent'='Kasho-Installer'}; Invoke-WebRequest -Uri $h.browser_download_url -OutFile '%HASH_FILE%' -Headers @{'User-Agent'='Kasho-Installer'}"
if errorlevel 1 (
  echo.
  echo  No published Kasho installer was found.
  echo  Check: https://github.com/%OWNER%/%REPO%/releases
  pause
  exit /b 1
)
echo  [2/4] Verifying installer integrity...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$expected=((Get-Content '%HASH_FILE%' -Raw).Trim() -split '\s+')[0].ToLower(); $actual=(Get-FileHash '%INSTALLER%' -Algorithm SHA256).Hash.ToLower(); if($expected -ne $actual){throw 'SHA256 verification failed.'}; Write-Host 'SHA256 verified.'"
if errorlevel 1 (
  del "%INSTALLER%" >nul 2>nul
  echo  Verification failed. Installation cancelled.
  pause
  exit /b 1
)
echo  [3/4] Starting Kasho Setup...
start /wait "" "%INSTALLER%"
if errorlevel 1 (
  echo.
  echo  Setup did not complete successfully.
  echo  You can run the downloaded installer again:
  echo  %INSTALLER%
  pause
  exit /b 1
)
echo  [4/4] Setup finished. Check the desktop for the Kasho shortcut.
pause
endlocal
