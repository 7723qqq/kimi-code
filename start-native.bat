@echo off
REM Kimi Code launcher with native Rust tools built.
REM Usage:
REM   start-native.bat               - Run Bun CLI with native Rust tools
REM   start-native.bat --pure-rust   - Run pure Rust standalone REPL binary (kimi-agent-cli)
REM   start-native.bat --web         - Run Web UI powered by native Rust server (kimi-agent --serve)

setlocal

set "WEB_NATIVE=0"
set "PURE_RUST=0"
if "%KIMI_PURE_RUST%"=="1" set "PURE_RUST=1"

REM `shift` never updates `%*`, so rebuild the argument list after consuming the
REM launcher flags; otherwise `--web` / `--pure-rust` leak into the CLI parser.
REM The flags are recognised in any position, so `--model X --web` works the same
REM as `--web --model X`.
REM The accumulator is written without the `set "VAR=..."` wrapper on purpose:
REM that wrapper pairs its own quotes with the ones around `%~1`, which leaves
REM `&`, `|`, `<` and `>` inside an argument unquoted -- the line then splits and
REM the argument is silently dropped.
set "REST_ARGS="
:collect_args
if "%~1"=="" goto :args_ready
if "%~1"=="--web" (
    set "WEB_NATIVE=1"
    shift
    goto :collect_args
)
if "%~1"=="--web-native" (
    set "WEB_NATIVE=1"
    shift
    goto :collect_args
)
if "%~1"=="--pure-rust" (
    set "PURE_RUST=1"
    shift
    goto :collect_args
)
set REST_ARGS=%REST_ARGS% "%~1"
shift
goto :collect_args
:args_ready

REM The standalone Rust CLI (kimi-agent-cli) backs both --web and --pure-rust.
set "NEED_RUST_CLI=0"
if "%WEB_NATIVE%"=="1" set "NEED_RUST_CLI=1"
if "%PURE_RUST%"=="1" set "NEED_RUST_CLI=1"

set "CLI_EXE=%~dp0packages\kimi-agent\target\release\kimi-agent-cli.exe"
if "%NEED_RUST_CLI%"=="1" (
    if not exist "%CLI_EXE%" (
        echo Building pure Rust standalone CLI...
        cd /d "%~dp0packages\kimi-agent"
        cargo build --release --features cli
        if errorlevel 1 (
            echo [ERROR] cargo build failed.
            pause
            exit /b 1
        )
        cd /d "%~dp0"
    )
)

if "%WEB_NATIVE%"=="1" (
    echo Launching Kimi Web UI powered by native Rust server...
    call bun run dev:cli web --rust-server %REST_ARGS%
    goto :done
)

if "%PURE_RUST%"=="1" (
    echo Launching pure Rust standalone REPL...
    "%CLI_EXE%" --repl %REST_ARGS%
    goto :done
)

REM Ensure the native engine addon is built.
REM napi-rs on Windows produces files named with the -msvc suffix.
set "NODE_FILE=%~dp0packages\kimi-agent\kimi_agent.win32-x64-msvc.node"
if not exist "%NODE_FILE%" (
    if not exist "%~dp0node_modules\@napi-rs\cli" (
        echo [ERROR] napi CLI not installed. Run `bun install` at the repo root first.
        pause
        exit /b 1
    )
    echo Building the native engine addon...
    cd /d "%~dp0packages\kimi-agent"
    bun run build 2>&1
    if errorlevel 1 (
        echo [ERROR] napi build failed. Make sure Rust and Visual Studio Build Tools are installed.
        echo         https://rustup.rs
        echo         https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022
        pause
        exit /b 1
    )
    cd /d "%~dp0"
)

REM Launch kimi-code CLI via Bun.
cd /d "%~dp0"
call bun run dev:cli %REST_ARGS%

:done
endlocal & exit /b %errorlevel%
