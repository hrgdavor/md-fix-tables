@echo off
REM Wrapper script to run md-fix-tables under bun or node
setlocal enabledelayedexpansion

if "%~1"=="" (
    echo Usage: md-fix-tables.bat <file.md>
    exit /b 1
)

REM Try bun first, fall back to node
if exist "bun.exe" (
    bun "%~dp0index.js" %*
) else if exist "node.exe" (
    node "%~dp0index.js" %*
) else (
    echo Error: Please install bun or node
    exit /b 1
)

exit /b !errorlevel!
