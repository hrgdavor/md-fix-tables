@echo off
REM Wrapper so the aligner can be run from cmd.exe: runs it under bun if bun is
REM on PATH, otherwise under node. All arguments are forwarded untouched.
setlocal enabledelayedexpansion

if "%~1"=="" (
    echo Usage: md-fix-tables.bat ^<file.md^> [--max-col=N] 1>&2
    exit /b 1
)

where bun >nul 2>nul
if !errorlevel! equ 0 (
    bun "%~dp0md-fix-tables.js" %*
    exit /b !errorlevel!
)

where node >nul 2>nul
if !errorlevel! equ 0 (
    node "%~dp0md-fix-tables.js" %*
    exit /b !errorlevel!
)

echo Error: neither bun nor node was found on PATH 1>&2
exit /b 1
