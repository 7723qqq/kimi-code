//! TUI theme — semantic color tokens for the transcript and UI chrome,
//! resolved from `~/.kimi-code/tui.toml`
//! (`theme = "dark" | "light" | "auto" | "<custom name>"`).
//! Custom themes are color-token maps under `~/.kimi-code/themes/<name>.json`
//! (TS custom-theme-loader parity). Mirrors the TS `ColorPalette` (dark/light)
//! in a compact form. `auto` probes the terminal background via OSC 11
//! (TS detect.ts parity) and falls back to dark.

use ratatui::style::Color;
use regex::Regex;
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Semantic color tokens the renderer uses (no hardcoded ratatui colors).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Theme {
    /// User prompt prefix.
    pub user: Color,
    /// Assistant text (default foreground).
    pub assistant: Color,
    /// Live streamed assistant text.
    pub stream: Color,
    /// Model reasoning (transient, dimmed).
    pub thinking: Color,
    /// Tool progress lines.
    pub tool: Color,
    /// Status / informational lines.
    pub status: Color,
    /// Errors.
    pub error: Color,
    /// Markdown headings.
    pub heading: Color,
    /// Inline / fenced code.
    pub code: Color,
    /// Blockquote text.
    pub quote: Color,
}

impl Theme {
    /// The dark palette (default).
    pub fn dark() -> Self {
        Self {
            user: Color::White,
            assistant: Color::White,
            stream: Color::Cyan,
            thinking: Color::DarkGray,
            tool: Color::Blue,
            status: Color::DarkGray,
            error: Color::Red,
            heading: Color::LightCyan,
            code: Color::Yellow,
            quote: Color::Gray,
        }
    }

    /// The light palette (dark text on a light terminal).
    pub fn light() -> Self {
        Self {
            user: Color::Black,
            assistant: Color::Black,
            stream: Color::Blue,
            thinking: Color::Gray,
            tool: Color::Magenta,
            status: Color::Gray,
            error: Color::Red,
            heading: Color::Blue,
            code: Color::Yellow,
            quote: Color::DarkGray,
        }
    }
}

/// Which theme the user requested (`auto` probes the terminal background via
/// OSC 11 and falls back to the dark palette; `Custom` names a JSON file in
/// the themes directory).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThemeChoice {
    Dark,
    Light,
    Auto,
    Custom(String),
}

/// Parse the `theme` value from a TUI config.
fn parse_theme_choice(value: Option<&str>) -> ThemeChoice {
    match value.map(str::trim) {
        Some("light") => ThemeChoice::Light,
        Some("dark") => ThemeChoice::Dark,
        Some("auto") => ThemeChoice::Auto,
        // Any other name is a custom theme in the themes directory
        // (previously unknown values silently fell back to auto).
        Some(other) => ThemeChoice::Custom(other.to_string()),
        None => ThemeChoice::Auto,
    }
}

/// Load the resolved theme from `tui.toml` (or the default dark palette when
/// the file / theme field is absent, or a custom theme fails to load).
pub fn load_theme() -> Theme {
    resolve_theme(tui_theme_choice())
}

/// Map a parsed choice to a palette. `auto` probes the terminal background
/// (OSC 11, with a `COLORFGBG` fallback) and falls back to the dark palette
/// when detection is unavailable. Custom themes fall back to the dark
/// palette on load failure so `load_theme` never fails.
fn resolve_theme(choice: ThemeChoice) -> Theme {
    match choice {
        ThemeChoice::Dark => Theme::dark(),
        ThemeChoice::Light => Theme::light(),
        ThemeChoice::Auto => detect_terminal_theme()
            .map(theme_for_detection)
            .unwrap_or_else(Theme::dark),
        ThemeChoice::Custom(name) => load_custom_theme(&name).unwrap_or_else(|_| Theme::dark()),
    }
}

/// Map a detected terminal background to a palette.
fn theme_for_detection(detected: DetectedTheme) -> Theme {
    match detected {
        DetectedTheme::Dark => Theme::dark(),
        DetectedTheme::Light => Theme::light(),
    }
}

/// The `theme` field value from `~/.kimi-code/tui.toml` (None when absent).
pub fn tui_theme_choice() -> ThemeChoice {
    let Some(path) = tui_config_path() else {
        return ThemeChoice::Auto;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return ThemeChoice::Auto;
    };
    let Ok(value) = text.parse::<toml::Value>() else {
        return ThemeChoice::Auto;
    };
    let theme = value
        .get("theme")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    parse_theme_choice(theme.as_deref())
}

/// The TUI config path: `$KIMI_CODE_HOME/tui.toml` or `~/.kimi-code/tui.toml`.
pub fn tui_config_path() -> Option<PathBuf> {
    tui_home_env_dir().map(|home| home.join("tui.toml"))
}

/// The kimi-code home base: `$KIMI_CODE_HOME` or `~/.kimi-code`
/// (Windows: `USERPROFILE`).
fn tui_home_env_dir() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("KIMI_CODE_HOME") {
        if !home.trim().is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    let base = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    }?;
    Some(PathBuf::from(base).join(".kimi-code"))
}

/// Read a top-level string field from `tui.toml`.
pub fn tui_config_field(key: &str) -> Option<String> {
    let path = tui_config_path()?;
    let text = std::fs::read_to_string(path).ok()?;
    let value: toml::Value = text.parse().ok()?;
    value.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// Set a top-level field in `tui.toml` (creates the file when absent).
/// Shared by `/locale`, `/editor`, and future chrome settings.
pub fn set_tui_config_field(key: &str, value: toml::Value) -> anyhow::Result<()> {
    let Some(path) = tui_config_path() else {
        anyhow::bail!("cannot locate tui.toml");
    };
    let mut doc = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| text.parse::<toml::Value>().ok())
        .unwrap_or_else(|| toml::Table::new().into());
    doc[key] = value;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, doc.to_string())?;
    Ok(())
}

// ============================================================================
// Terminal background detection (OSC 11) — TS detect.ts / terminal-background.ts
// parity. `auto` probes the terminal's background color instead of assuming
// dark, so light terminals get the light palette.
// ============================================================================

/// Detected terminal background (TS `ResolvedTheme`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectedTheme {
    Dark,
    Light,
}

/// Probe timeout (TS `TERMINAL_THEME_DETECT_TIMEOUT_MS = 250`). Terminals
/// reply within a few ms; unsupported terminals never reply, so the wait is
/// hard-capped and falls back to dark. The probe runs once at startup (in
/// `load_theme`, before the app enters raw mode — same ordering as TS).
const OSC11_TIMEOUT: Duration = Duration::from_millis(250);

/// OSC 11 background-color query, BEL-terminated (TS `OSC11_QUERY`).
const OSC11_QUERY: &[u8] = b"\x1b]11;?\x07";

/// OSC 11 response matcher (TS `OSC11_RESPONSE`): optional leading ESC,
/// `]11;rgb:RRRR/GGGG/BBBB` with 1-4 hex digits per channel, terminated by
/// BEL or ST. Unanchored and case-insensitive so replies echoed alongside
/// other raw input still match.
fn osc11_response_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)\x1b?\]11;rgb:([0-9a-f]{1,4})/([0-9a-f]{1,4})/([0-9a-f]{1,4})(?:\x07|\x1b\\)",
        )
        .expect("OSC 11 response regex is valid")
    })
}

/// Normalize an OSC 11 channel (1-4 hex digits) to `[0, 1]` (TS parity: the
/// value is scaled by its own max, `(1 << len*4) - 1`, so `0` is black and
/// `f`/`ff`/`fff`/`ffff` are white regardless of digit count).
fn osc11_channel_value(channel: &str) -> Option<f64> {
    if channel.is_empty() || channel.len() > 4 {
        return None;
    }
    let value = u64::from_str_radix(channel, 16).ok()?;
    let max = (1u64 << (channel.len() * 4)) - 1;
    Some(value as f64 / max as f64)
}

/// Relative luminance with sRGB-linearised weights (TS parity). The `> 0.5`
/// threshold splits dark/light backgrounds reliably: pure black is 0.0
/// (dark), pure white is 1.0 (light), and exactly 0.5 counts as dark.
fn luminance_is_light((r, g, b): (f64, f64, f64)) -> bool {
    0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5
}

/// Parse an OSC 11 background response out of a raw input buffer (the reply
/// may arrive interleaved with other input). Returns `Some(theme)` on the
/// first complete, valid response; `None` when the buffer holds none yet.
fn parse_osc11_background(data: &str) -> Option<DetectedTheme> {
    let caps = osc11_response_regex().captures(data)?;
    let r = osc11_channel_value(caps.get(1)?.as_str())?;
    let g = osc11_channel_value(caps.get(2)?.as_str())?;
    let b = osc11_channel_value(caps.get(3)?.as_str())?;
    Some(if luminance_is_light((r, g, b)) {
        DetectedTheme::Light
    } else {
        DetectedTheme::Dark
    })
}

/// VT100 / xterm `COLORFGBG` fallback: `"fg;bg"` (sometimes
/// `"fg;default;bg"`). The last token is the ANSI 16-color background index;
/// 0-6 and 8 are dark, the rest light (TS `parseColorFgBg` parity).
fn parse_color_fg_bg(value: Option<&str>) -> Option<DetectedTheme> {
    let value = value.filter(|v| !v.is_empty())?;
    let bg_raw = value.split(';').next_back()?;
    // Simplified JS `parseInt` semantics: leading digits, then stop.
    let digits: String = bg_raw
        .trim_start_matches('-')
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    let bg: i32 = digits.parse().ok()?;
    if bg < 0 {
        return None;
    }
    Some(if matches!(bg, 0..=6 | 8) {
        DetectedTheme::Dark
    } else {
        DetectedTheme::Light
    })
}

/// TS detect.ts parity — reject when stdin/stdout are not both interactive
/// terminals, or when colors are disabled (`NO_COLOR` / `FORCE_COLOR=0` /
/// `CI`). In the test environment stdout is captured (not a TTY), so tests
/// never reach the probe.
fn detection_suppressed() -> bool {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return true;
    }
    if std::env::var("NO_COLOR").is_ok_and(|v| !v.is_empty()) {
        return true;
    }
    if std::env::var("FORCE_COLOR").is_ok_and(|v| v == "0") {
        return true;
    }
    if std::env::var("CI").is_ok_and(|v| !v.is_empty() && v != "0") {
        return true;
    }
    false
}

/// Detect the terminal background (TS `detectTerminalTheme`): an OSC 11
/// probe, then the `COLORFGBG` fallback, then `None` (→ dark). Returns `None`
/// early for non-TTY stdin/stdout or color opt-outs. Never blocks longer
/// than [`OSC11_TIMEOUT`] and never fails.
pub(crate) fn detect_terminal_theme() -> Option<DetectedTheme> {
    if detection_suppressed() {
        return None;
    }
    query_osc11_background().or_else(|| parse_color_fg_bg(std::env::var("COLORFGBG").ok().as_deref()))
}

/// One-shot OSC 11 probe (TS `queryOsc11`): enter raw mode so the reply is
/// delivered byte-by-byte instead of line-buffered, write the query, wait up
/// to [`OSC11_TIMEOUT`], then restore the previous terminal mode. Any
/// failure (no reply, timeout, I/O error) yields `None`. TS skips the probe
/// when another stdin listener is attached; at startup nothing listens yet,
/// so that guard is unnecessary here.
fn query_osc11_background() -> Option<DetectedTheme> {
    let was_raw = crossterm::terminal::is_raw_mode_enabled().ok()?;
    if !was_raw {
        crossterm::terminal::enable_raw_mode().ok()?;
    }
    let result = query_osc11_reply();
    if !was_raw {
        // Best-effort restore; a probe failure must never corrupt the
        // terminal state that the app's own raw mode (set up later in
        // `init_terminal`) depends on.
        let _ = crossterm::terminal::disable_raw_mode();
    }
    result
}

/// The raw-mode part of the probe: send the query and collect the reply.
/// The wait is a 5ms sleep-poll over [`stdin_wait`], so unsupported
/// terminals cost at most [`OSC11_TIMEOUT`] once at startup (TS parity) and
/// the probe never steals keystrokes from the event loop.
fn query_osc11_reply() -> Option<DetectedTheme> {
    let mut stdout = io::stdout();
    stdout.write_all(OSC11_QUERY).ok()?;
    stdout.flush().ok()?;

    let deadline = Instant::now() + OSC11_TIMEOUT;
    let mut buf: Vec<u8> = Vec::with_capacity(64);
    let mut chunk = [0u8; 64];
    loop {
        if Instant::now() >= deadline {
            return None;
        }
        if !stdin_wait::has_input() {
            // No input pending yet — poll again shortly.
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        match io::stdin().read(&mut chunk) {
            Ok(0) => return None,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(theme) = parse_osc11_background(&String::from_utf8_lossy(&buf)) {
                    return Some(theme);
                }
                // TS `TERMINAL_THEME_INPUT_BUFFER_MAX_LENGTH`: stop once the
                // buffer grows past the reply size (garbage input).
                if buf.len() > 512 {
                    return None;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }
}

/// Non-blocking stdin wait primitives. A bare `std::io::stdin().read()`
/// blocks until input arrives, and crossterm's event source consumes raw
/// bytes while polling (both the Unix and Windows `try_read` implementations
/// read the tty / console input as part of `event::poll`), so the probe
/// waits with platform-native non-blocking checks instead.
#[cfg(unix)]
mod stdin_wait {
    use std::io;
    use std::os::fd::AsRawFd;

    /// `struct pollfd` — `{ int fd; short events; short revents; }`, an
    /// 8-byte layout identical on every Unix.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct PollFd {
        fd: i32,
        events: i16,
        revents: i16,
    }

    const POLLIN: i16 = 0x0001;

    extern "C" {
        fn poll(fds: *mut PollFd, nfds: usize, timeout: i32) -> i32;
    }

    /// Whether stdin currently has readable bytes, without blocking.
    pub(super) fn has_input() -> bool {
        poll_fd_has_input(io::stdin().as_raw_fd())
    }

    /// `poll(2)` with a zero timeout on an arbitrary fd (`nfds` is passed as
    /// `usize`; the value 1 in the low bits is correct for both the 32-bit
    /// `nfds_t` of macOS/BSD and the 64-bit one of Linux).
    pub(super) fn poll_fd_has_input(fd: i32) -> bool {
        let mut fds = [PollFd {
            fd,
            events: POLLIN,
            revents: 0,
        }];
        loop {
            let r = unsafe { poll(fds.as_mut_ptr(), 1, 0) };
            if r > 0 {
                return fds[0].revents & POLLIN != 0;
            }
            if r == 0 {
                return false;
            }
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            // Closed stdin / other error — treat as "no input".
            return false;
        }
    }
}

/// Non-blocking stdin wait primitives: `PeekNamedPipe` (pipes, and console
/// input where supported) with a `PeekConsoleInput` fallback for console
/// input handles. Both return without consuming input.
#[cfg(windows)]
mod stdin_wait {
    use core::ffi::c_void;

    /// `(DWORD)-10`.
    const STD_INPUT_HANDLE: u32 = 0xFFFF_FFF6;

    /// Opaque console input record; only its 20-byte size matters here.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct InputRecord([u8; 20]);

    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(n_std_handle: u32) -> *mut c_void;
        fn PeekNamedPipe(
            pipe: *mut c_void,
            buffer: *mut c_void,
            buffer_size: u32,
            bytes_read: *mut u32,
            total_bytes_avail: *mut u32,
            bytes_left_this_message: *mut u32,
        ) -> i32;
        fn PeekConsoleInputW(
            console_input: *mut c_void,
            buffer: *mut InputRecord,
            length: u32,
            number_of_events_read: *mut u32,
        ) -> i32;
    }

    /// Whether stdin currently has readable bytes, without blocking.
    pub(super) fn has_input() -> bool {
        let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        if handle.is_null() {
            return false;
        }
        peek_bytes_available(handle).unwrap_or(0) > 0 || peek_console_records(handle)
    }

    /// Bytes available on a pipe/console handle via `PeekNamedPipe`, without
    /// consuming them. `None` when the handle is not peekable.
    pub(super) fn peek_bytes_available(handle: *mut c_void) -> Option<u32> {
        let mut total: u32 = 0;
        let ok = unsafe {
            PeekNamedPipe(
                handle,
                core::ptr::null_mut(),
                0,
                core::ptr::null_mut(),
                &mut total,
                core::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(total)
    }

    /// Whether console input records are pending (`PeekConsoleInputW`
    /// fallback for handles `PeekNamedPipe` rejects).
    fn peek_console_records(handle: *mut c_void) -> bool {
        let mut record = InputRecord([0u8; 20]);
        let mut count: u32 = 0;
        let ok = unsafe { PeekConsoleInputW(handle, &mut record, 1, &mut count) };
        ok != 0 && count > 0
    }
}

// ============================================================================
// Custom themes — `~/.kimi-code/themes/<name>.json`, a JSON object mapping
// color tokens to hex strings (TS custom-theme-loader parity).
// ============================================================================

/// Test-only home override (process-local, mutex-guarded — never touches the
/// environment; mirrors `util.rs`'s `set_test_home`). Consulted only by
/// `themes_dir`, never by `tui_config_path`.
static TEST_THEME_HOME: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// Serializes the tests that mutate [`TEST_THEME_HOME`] (cargo runs test
/// functions in parallel threads within one process).
#[cfg(test)]
static TEST_THEME_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
fn set_test_theme_home(home: Option<PathBuf>) {
    *TEST_THEME_HOME.lock().unwrap_or_else(|e| e.into_inner()) = home;
}

/// The custom themes directory: `$KIMI_CODE_HOME/themes` or
/// `~/.kimi-code/themes` (same resolution rule as [`tui_config_path`]).
fn themes_dir() -> Option<PathBuf> {
    let test_home = TEST_THEME_HOME
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let home = test_home.or_else(tui_home_env_dir)?;
    Some(home.join("themes"))
}

/// Names of the custom themes available in the themes directory, sorted,
/// without the `.json` extension. Empty when the directory is missing.
pub fn list_custom_themes() -> Vec<String> {
    let Some(dir) = themes_dir() else {
        return Vec::new();
    };
    theme_names_in_dir(&dir)
}

/// Theme names = `*.json` file names with the extension stripped, sorted.
fn theme_names_in_dir(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|entry| {
            entry
                .path()
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
        })
        .collect();
    names.sort();
    names
}

/// Load a custom theme from `~/.kimi-code/themes/{name}.json`: a JSON object
/// mapping color tokens to hex strings (`#RGB` or `#RRGGBB`). Tokens absent
/// from the file keep the dark palette values. A missing file, invalid JSON,
/// a non-object document, or an invalid hex color yields an error that names
/// the file.
pub fn load_custom_theme(name: &str) -> anyhow::Result<Theme> {
    let Some(dir) = themes_dir() else {
        anyhow::bail!("cannot locate the kimi-code home (themes directory)");
    };
    let path = dir.join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("failed to read custom theme {}: {e}", path.display()))?;
    parse_theme_json(&text)
        .map_err(|e| anyhow::anyhow!("invalid custom theme {}: {e}", path.display()))
}

/// Parse a custom-theme JSON document. Unknown keys are ignored; missing
/// tokens fall back to the dark palette.
fn parse_theme_json(json: &str) -> anyhow::Result<Theme> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| anyhow::anyhow!("not valid JSON: {e}"))?;
    let map = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("expected a JSON object of color tokens"))?;
    let mut theme = Theme::dark();
    for (key, slot) in [
        ("user", &mut theme.user),
        ("assistant", &mut theme.assistant),
        ("stream", &mut theme.stream),
        ("thinking", &mut theme.thinking),
        ("tool", &mut theme.tool),
        ("status", &mut theme.status),
        ("error", &mut theme.error),
        ("heading", &mut theme.heading),
        ("code", &mut theme.code),
        ("quote", &mut theme.quote),
    ] {
        if let Some(hex) = map.get(key).and_then(|v| v.as_str()) {
            *slot = parse_hex_color(hex).map_err(|e| anyhow::anyhow!("token \"{key}\": {e}"))?;
        }
    }
    Ok(theme)
}

/// Parse `#RGB` or `#RRGGBB` (case-insensitive; `#RGB` doubles each nibble).
fn parse_hex_color(raw: &str) -> anyhow::Result<Color> {
    let hex = raw.trim();
    let digits = hex
        .strip_prefix('#')
        .ok_or_else(|| anyhow::anyhow!("color \"{hex}\" must start with '#'"))?;
    let nibble = |b: u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    };
    let rgb = match digits.len() {
        3 => {
            let bytes = digits.as_bytes();
            [
                nibble(bytes[0]).ok_or_else(|| invalid_hex(hex))? * 17,
                nibble(bytes[1]).ok_or_else(|| invalid_hex(hex))? * 17,
                nibble(bytes[2]).ok_or_else(|| invalid_hex(hex))? * 17,
            ]
        }
        6 => {
            let bytes = digits.as_bytes();
            let mut rgb = [0u8; 3];
            for (i, pair) in bytes.chunks_exact(2).enumerate() {
                let hi = nibble(pair[0]).ok_or_else(|| invalid_hex(hex))?;
                let lo = nibble(pair[1]).ok_or_else(|| invalid_hex(hex))?;
                rgb[i] = hi * 16 + lo;
            }
            rgb
        }
        _ => anyhow::bail!("color \"{hex}\" must be #RGB or #RRGGBB"),
    };
    Ok(Color::Rgb(rgb[0], rgb[1], rgb[2]))
}

fn invalid_hex(hex: &str) -> anyhow::Error {
    anyhow::anyhow!("color \"{hex}\" must be #RGB or #RRGGBB hex")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_and_light_palettes_are_distinct() {
        let dark = Theme::dark();
        let light = Theme::light();
        assert_ne!(dark.tool, light.tool);
        assert_ne!(dark.stream, light.stream);
        assert_ne!(dark.heading, light.heading);
    }

    #[test]
    fn theme_choice_parses() {
        assert_eq!(parse_theme_choice(Some("dark")), ThemeChoice::Dark);
        assert_eq!(parse_theme_choice(Some("light")), ThemeChoice::Light);
        assert_eq!(parse_theme_choice(Some("auto")), ThemeChoice::Auto);
        assert_eq!(
            parse_theme_choice(Some("fancy-custom")),
            ThemeChoice::Custom("fancy-custom".to_string())
        );
        assert_eq!(parse_theme_choice(None), ThemeChoice::Auto);
    }

    #[test]
    fn load_theme_never_fails() {
        // No KIMI_CODE_HOME, no tui.toml in the test env -> falls back.
        let theme = load_theme();
        let _ = theme.user;
    }

    #[test]
    fn hex_colors_parse() {
        assert_eq!(parse_hex_color("#fff").unwrap(), Color::Rgb(255, 255, 255));
        assert_eq!(parse_hex_color("#0ff").unwrap(), Color::Rgb(0, 255, 255));
        assert_eq!(parse_hex_color("#FF0000").unwrap(), Color::Rgb(255, 0, 0));
        assert_eq!(parse_hex_color("#123456").unwrap(), Color::Rgb(0x12, 0x34, 0x56));
        assert_eq!(parse_hex_color(" #0A0B0C ").unwrap(), Color::Rgb(0x0a, 0x0b, 0x0c));
        for bad in [
            "", "fff", "#", "#ff", "#ffff", "#ggg", "#12345", "#1234567", "#12 345",
        ] {
            assert!(parse_hex_color(bad).is_err(), "expected {bad:?} to fail");
        }
    }

    #[test]
    fn custom_theme_json_parses_with_dark_defaults() {
        let theme =
            parse_theme_json(r##"{"user": "#0ff", "stream": "#00ff00", "error": "#ff0000"}"##)
                .unwrap();
        assert_eq!(theme.user, Color::Rgb(0, 255, 255));
        assert_eq!(theme.stream, Color::Rgb(0, 255, 0));
        assert_eq!(theme.error, Color::Rgb(255, 0, 0));
        // Tokens absent from the JSON keep the dark palette values.
        assert_eq!(theme.assistant, Theme::dark().assistant);
        assert_eq!(theme.heading, Theme::dark().heading);
        assert_eq!(theme.quote, Theme::dark().quote);
        // Unknown keys and non-string values are ignored.
        assert_eq!(
            parse_theme_json(r##"{"unknown": "#000", "user": 123}"##).unwrap(),
            Theme::dark()
        );
        // Invalid documents / hex colors -> Err.
        assert!(parse_theme_json("not json").is_err());
        assert!(parse_theme_json("[1, 2]").is_err());
        assert!(parse_theme_json(r##"{"user": "#xyz"}"##).is_err());
    }

    #[test]
    fn custom_themes_list_and_load_roundtrip() {
        let _guard = TEST_THEME_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-tui-theme-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let themes = home.join("themes");
        std::fs::create_dir_all(&themes).unwrap();
        std::fs::write(
            themes.join("ocean.json"),
            r##"{"user": "#0ff", "stream": "#00ff00"}"##,
        )
        .unwrap();
        std::fs::write(themes.join("matrix.json"), r##"{"error": "#ff0000"}"##).unwrap();
        set_test_theme_home(Some(home.clone()));

        assert_eq!(list_custom_themes(), vec!["matrix", "ocean"]);

        let ocean = load_custom_theme("ocean").unwrap();
        assert_eq!(ocean.user, Color::Rgb(0, 255, 255));
        assert_eq!(ocean.stream, Color::Rgb(0, 255, 0));
        assert_eq!(ocean.error, Theme::dark().error); // missing token -> dark default
        assert_eq!(ocean.assistant, Theme::dark().assistant);

        let matrix = load_custom_theme("matrix").unwrap();
        assert_eq!(matrix.error, Color::Rgb(255, 0, 0));
        assert_eq!(matrix.user, Theme::dark().user);

        // Missing file / invalid JSON / invalid hex -> Err.
        assert!(load_custom_theme("nope").is_err());
        std::fs::write(themes.join("broken.json"), "{not json").unwrap();
        assert!(load_custom_theme("broken").is_err());
        std::fs::write(themes.join("badhex.json"), r##"{"user": "#zzz"}"##).unwrap();
        assert!(load_custom_theme("badhex").is_err());

        // Broken files still show up in the listing (extension-only filter).
        assert_eq!(
            list_custom_themes(),
            vec!["badhex", "broken", "matrix", "ocean"]
        );

        set_test_theme_home(None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn list_custom_themes_empty_when_dir_missing() {
        let _guard = TEST_THEME_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home =
            std::env::temp_dir().join(format!("kimi-tui-theme-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        set_test_theme_home(Some(home.clone())); // no themes/ subdir
        assert!(list_custom_themes().is_empty());
        assert!(load_custom_theme("anything").is_err());
        set_test_theme_home(None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn custom_theme_failure_falls_back_to_dark() {
        let _guard = TEST_THEME_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-tui-theme-fb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        // No themes dir yet: a missing custom theme falls back to dark.
        set_test_theme_home(Some(home.clone()));
        assert_eq!(
            resolve_theme(ThemeChoice::Custom("missing".to_string())),
            Theme::dark()
        );

        // A valid custom theme resolves through the same path.
        let themes = home.join("themes");
        std::fs::create_dir_all(&themes).unwrap();
        std::fs::write(themes.join("ok.json"), r##"{"stream": "#00ff00"}"##).unwrap();
        let theme = resolve_theme(ThemeChoice::Custom("ok".to_string()));
        assert_eq!(theme.stream, Color::Rgb(0, 255, 0));
        assert_eq!(theme.user, Theme::dark().user);

        set_test_theme_home(None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn osc11_responses_parse() {
        // BEL and ST terminators, 1-4 hex digits per channel, optional
        // leading ESC, case-insensitive, unanchored within other input.
        assert_eq!(
            parse_osc11_background("\x1b]11;rgb:0000/0000/0000\x1b\\"),
            Some(DetectedTheme::Dark)
        );
        assert_eq!(
            parse_osc11_background("\x1b]11;rgb:ffff/ffff/ffff\x07"),
            Some(DetectedTheme::Light)
        );
        assert_eq!(
            parse_osc11_background("\x1b]11;rgb:ff/ff/ff\x1b\\"),
            Some(DetectedTheme::Light)
        );
        assert_eq!(
            parse_osc11_background("\x1b]11;rgb:0/0/0\x07"),
            Some(DetectedTheme::Dark)
        );
        assert_eq!(
            parse_osc11_background("\x1b]11;rgb:fff/fff/fff\x1b\\"),
            Some(DetectedTheme::Light)
        );
        // No leading ESC (reply echoed alongside other raw input).
        assert_eq!(
            parse_osc11_background("]11;rgb:ffff/ffff/ffff\x07"),
            Some(DetectedTheme::Light)
        );
        // Reply embedded in other input.
        assert_eq!(
            parse_osc11_background("prefix\x1b]11;rgb:0000/0000/0000\x07suffix"),
            Some(DetectedTheme::Dark)
        );
        // Case-insensitive marker and channels.
        assert_eq!(
            parse_osc11_background("\x1b]11;RGB:FF/FF/FF\x07"),
            Some(DetectedTheme::Light)
        );
        // Near the 0.5 luminance threshold (4-digit channels).
        assert_eq!(
            parse_osc11_background("\x1b]11;rgb:8000/8000/8000\x07"),
            Some(DetectedTheme::Light)
        );
        assert_eq!(
            parse_osc11_background("\x1b]11;rgb:7fff/7fff/7fff\x07"),
            Some(DetectedTheme::Dark)
        );
        // Mixed channel widths: luma ≈ 0.495 < 0.5 → dark.
        assert_eq!(
            parse_osc11_background("\x1b]11;rgb:1234/abcd/00ff\x1b\\"),
            Some(DetectedTheme::Dark)
        );
    }

    #[test]
    fn osc11_invalid_responses_are_rejected() {
        for bad in [
            "",
            "hello",
            "\x1b]11;rgb:\x07",
            "\x1b]11;rgb:ff/ff\x07",              // only two channels
            "\x1b]11;rgb:fffff/ffff/ffff\x07",    // five-digit channel
            "\x1b]11;rgb:fg/fg/fg\x07",           // non-hex channel
            "\x1b]10;rgb:ff/ff/ff\x07",           // wrong OSC number
            "\x1b]11;rgb:ff/ff/ff",               // no terminator
            "\x1b]11;rgb:ff/ff/ff\x1b",           // ST without backslash
            "\x1b]11;rgb:\u{80}/\u{80}/\u{80}\x07", // non-ASCII "channels"
        ] {
            assert_eq!(
                parse_osc11_background(bad),
                None,
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn luminance_threshold_splits_dark_and_light() {
        assert!(luminance_is_light((1.0, 1.0, 1.0)));
        assert!(!luminance_is_light((0.0, 0.0, 0.0)));
        // Exactly 0.5 is not > 0.5 → dark (TS parity).
        assert!(!luminance_is_light((0.5, 0.5, 0.5)));
        assert!(!luminance_is_light((1.0, 0.0, 0.0))); // luma 0.2126
        assert!(luminance_is_light((0.0, 1.0, 0.0))); // luma 0.7152
    }

    #[test]
    fn color_fg_bg_parses() {
        assert_eq!(parse_color_fg_bg(Some("0;0")), Some(DetectedTheme::Dark));
        assert_eq!(parse_color_fg_bg(Some("0;15")), Some(DetectedTheme::Light));
        assert_eq!(
            parse_color_fg_bg(Some("0;default;0")),
            Some(DetectedTheme::Dark)
        );
        assert_eq!(
            parse_color_fg_bg(Some("0;default;7")),
            Some(DetectedTheme::Light)
        );
        assert_eq!(parse_color_fg_bg(Some("0;8")), Some(DetectedTheme::Dark));
        assert_eq!(parse_color_fg_bg(Some("0;9")), Some(DetectedTheme::Light));
        for bad in [None, Some(""), Some("x"), Some("0;"), Some("0;abc")] {
            assert_eq!(parse_color_fg_bg(bad), None, "expected {bad:?} to fail");
        }
    }

    #[test]
    fn auto_resolves_to_dark_when_detection_is_unavailable() {
        // The test harness captures stdout (not a TTY), so detection is
        // suppressed and `auto` keeps its fallback semantics.
        assert_eq!(resolve_theme(ThemeChoice::Auto), Theme::dark());
        assert_eq!(detect_terminal_theme(), None);
    }

    #[cfg(unix)]
    #[test]
    fn poll_sees_written_bytes_without_consuming() {
        use std::io::Write as _;
        use std::os::unix::net::UnixStream;

        let (a, b) = UnixStream::pair().expect("unix pair");
        assert!(!stdin_wait::poll_fd_has_input(a.as_raw_fd()));
        b.write_all(b"hi").unwrap();
        assert!(stdin_wait::poll_fd_has_input(a.as_raw_fd()));
        // poll only signals; the bytes are still there to be read.
        let mut buf = [0u8; 8];
        assert_eq!(a.read(&mut buf).unwrap(), 2);
        assert_eq!(&buf[..2], b"hi");
    }

    #[cfg(windows)]
    #[test]
    fn peeking_named_pipe_reports_available_bytes() {
        use std::io::Read as _;
        use std::os::windows::io::AsRawHandle;
        use std::process::{Command, Stdio};

        // A pipe with data in it: `cmd /c echo abc` writes to its stdout,
        // which is the read end we hold.
        let mut child = Command::new("cmd")
            .args(["/c", "echo abc"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn cmd");
        let mut stdout = child.stdout.take().expect("piped stdout");
        let status = child.wait().expect("wait cmd");
        assert!(status.success(), "cmd should exit 0");

        // The bytes are already in the pipe buffer, and peek does not
        // consume them.
        assert_eq!(
            stdin_wait::peek_bytes_available(stdout.as_raw_handle()),
            Some(5)
        );
        let mut text = String::new();
        stdout.read_to_string(&mut text).unwrap();
        assert_eq!(text, "abc\r\n");
        // After EOF (the child's write end is closed) the pipe is broken, so
        // peek reports "not peekable" rather than an empty buffer.
        assert_eq!(stdin_wait::peek_bytes_available(stdout.as_raw_handle()), None);
    }
}
