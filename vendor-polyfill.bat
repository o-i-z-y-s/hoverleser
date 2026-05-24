@echo off
setlocal enabledelayedexpansion

set CDNJS=https://cdnjs.cloudflare.com/ajax/libs/webextension-polyfill/0.12.0/browser-polyfill.min.js
set UNPKG=https://unpkg.com/webextension-polyfill@0.12.0/dist/browser-polyfill.min.js
set OUTFILE=src\lib\browser-polyfill.min.js
set TMP_A=%TEMP%\polyfill_cdnjs.js
set TMP_B=%TEMP%\polyfill_unpkg.js

echo.
echo Downloading from cdnjs (Cloudflare)...
curl -fsSL "%CDNJS%" -o "%TMP_A%"
if errorlevel 1 ( echo ERROR: cdnjs download failed & goto :fail )

echo Downloading from unpkg (npm registry)...
curl -fsSL "%UNPKG%" -o "%TMP_B%"
if errorlevel 1 ( echo ERROR: unpkg download failed & goto :fail )

echo.
echo Computing SHA-256...

for /f "skip=1 tokens=*" %%H in ('certutil -hashfile "%TMP_A%" SHA256') do (
    if not defined HASH_A set HASH_A=%%H
)
for /f "skip=1 tokens=*" %%H in ('certutil -hashfile "%TMP_B%" SHA256') do (
    if not defined HASH_B set HASH_B=%%H
)

echo cdnjs : %HASH_A%
echo unpkg : %HASH_B%
echo.

if /i not "%HASH_A%"=="%HASH_B%" (
    echo MISMATCH - sources disagree. Do not use this file.
    goto :fail
)

echo PASS: both sources agree.
if not exist "src\lib" mkdir "src\lib"
copy /y "%TMP_A%" "%OUTFILE%" >nul
echo Saved: %OUTFILE%
echo.
echo Next step: git add %OUTFILE% and commit.

del "%TMP_A%" "%TMP_B%" >nul 2>&1
pause
exit /b 0

:fail
del "%TMP_A%" "%TMP_B%" >nul 2>&1
pause
exit /b 1
