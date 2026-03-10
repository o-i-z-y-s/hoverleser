@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: hoverleser – package.bat  (Windows)
::
:: Usage:
::   package.bat build          Build unsigned XPI
::   package.bat sign           Sign via Mozilla AMO (requires API credentials)
::
:: For signing, set environment variables before running:
::   set AMO_API_KEY=user:12345:678
::   set AMO_API_SECRET=abc123...
::   package.bat sign
:: ─────────────────────────────────────────────────────────────────────────────
setlocal

cd /d "%~dp0"
if not exist dist mkdir dist

for /f "delims=" %%v in ('node -e "process.stdout.write(require(\"./manifest.json\").version)"') do set VERSION=%%v
set OUT=dist\hoverleser-%VERSION%.xpi

if "%1"=="sign" goto :sign
goto :build

:build
echo Building hoverleser v%VERSION%...

if exist "%OUT%" del "%OUT%"

powershell -NoProfile -Command ^
  "$files = @('manifest.json','background.js','content.js','popup.html','popup.js'); ^
   $tmp = [IO.Path]::GetTempFileName() + '.zip'; ^
   Add-Type -Assembly System.IO.Compression.FileSystem; ^
   $z = [IO.Compression.ZipFile]::Open($tmp,'Create'); ^
   foreach ($f in $files) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z,$f,$f) }; ^
   [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z,'icons\icon48.png','icons/icon48.png'); ^
   $z.Dispose(); Move-Item $tmp '%OUT%'"

echo.
echo   Built: %OUT%  [unsigned]
echo.
echo   For a signed build (required for regular Firefox):
echo     set AMO_API_KEY=user:12345:678
echo     set AMO_API_SECRET=abc123...
echo     package.bat sign
echo.
goto :end

:sign
if "%AMO_API_KEY%"=="" (
  echo.
  echo   Error: AMO_API_KEY not set.
  echo   Get credentials at: https://addons.mozilla.org/developers/addon/api/key/
  echo.
  goto :end
)
if "%AMO_API_SECRET%"=="" (
  echo.
  echo   Error: AMO_API_SECRET not set.
  echo.
  goto :end
)

echo Signing via Mozilla AMO ^(unlisted^)...
call npx web-ext sign --source-dir . --artifacts-dir dist --channel unlisted --api-key %AMO_API_KEY% --api-secret %AMO_API_SECRET% --ignore-files "package.sh" "package.bat" "node_modules/**" "dist/**" "scripts/**" "README.md"
echo.
echo   Done. Upload the signed .xpi from the dist\ folder to GitHub Releases.
echo.

:end
endlocal
pause
