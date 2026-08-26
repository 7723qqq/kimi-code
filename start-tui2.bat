@echo off
REM Kimi Code TUI2 launcher - runs the opentui + SolidJS v2 TUI under Bun.
REM The opentui renderer needs Bun - its ffi backend; the Node SEA can't draw it.
REM This is the interactive tui2 chain: main.ts -> run-shell -> runKimiTui2.
REM Usage: double-click, or run from cmd/powershell and append CLI args after
REM        the script name (e.g. start-tui2.bat --yolo).

setlocal

REM Force the v2 opentui variant regardless of any inherited KIMI_TUI.
set "KIMI_TUI=v2"

cd /d "%~dp0"

REM Bun is required - opentui's ffi backend only works under Bun.
where bun >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Bun is required to run the tui2 opentui stack.
    echo         Install it from https://bun.sh, then re-run this launcher.
    pause
    exit /b 1
)

REM Ensure native module is built if running on Windows.
set "NODE_FILE=%~dp0packages\kimi-native-tools\kimi-native-tools.win32-x64-msvc.node"
if not exist "%NODE_FILE%" (
    if exist "%~dp0packages\kimi-native-tools\Cargo.toml" (
        where cargo >nul 2>nul
        if not errorlevel 1 (
            echo Building native tools...
            cd /d "%~dp0\packages\kimi-native-tools"
            cargo build --release 2>&1
            if not errorlevel 1 (
                copy /y "target\release\kimi_native_tools.dll" "kimi-native-tools.win32-x64-msvc.node" >nul
            )
            cd /d "%~dp0"
        )
    )
)

REM Launch the full interactive CLI under Bun with the v2 TUI.
echo Starting Kimi Code - tui2 opentui...
bun apps\kimi-code\src\main.ts %*

set "EXIT=%ERRORLEVEL%"
if not "%EXIT%"=="0" (
    if not "%EXIT%"=="130" (
        echo.
        echo [tui2] Exited with code %EXIT%.
        pause
    )
)
endlocal & exit /b %EXIT%
