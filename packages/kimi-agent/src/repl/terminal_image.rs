//! Terminal graphics for the standalone REPL.
//!
//! A port of the protocol layer `packages/pi-tui/src/terminal-image.ts` has,
//! reduced to what a line-oriented REPL can actually use. The probe order and
//! the escape sequences are kept identical to that file on purpose: two
//! implementations that disagree about which terminal speaks what is worse
//! than one that is merely incomplete.
//!
//! What differs, and why:
//!
//! - **No delta rendering.** pi-tui maintains a screen buffer; the REPL
//!   appends. An image is therefore written as a self-contained block, and a
//!   re-render means rewriting the block, not patching it.
//! - **No per-cell geometry by default.** The Kitty/iTerm2 cell-size query
//!   needs a response the REPL would have to read mid-turn; the terminal
//!   reports a conventional 9x18 cell unless one is supplied.

use std::io::Write;

/// The graphics protocol a terminal speaks, or `None` when it speaks none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageProtocol {
    Kitty,
    Iterm2,
    Sixel,
}

/// What the current terminal can render.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalCapabilities {
    pub images: Option<ImageProtocol>,
    pub true_color: bool,
}

/// Conventional terminal cell size in pixels, used when the terminal does not
/// report one. Matches pi-tui's default so both frontends size a picture the
/// same way on the same terminal.
pub const DEFAULT_CELL_WIDTH_PX: u32 = 9;
pub const DEFAULT_CELL_HEIGHT_PX: u32 = 18;

/// How many cells a picture was sized to (pi-tui's `ImageCellSize`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellSize {
    pub columns: u32,
    pub rows: u32,
}

/// An environment snapshot, so the probe is testable without touching the
/// real process environment.
#[derive(Debug, Default, Clone)]
pub struct ProbeEnv {
    pub term: Option<String>,
    pub term_program: Option<String>,
    pub colorterm: Option<String>,
    pub tmux: Option<String>,
    pub kitty_window_id: Option<String>,
    pub ghostty_resources_dir: Option<String>,
    pub wezterm_pane: Option<String>,
    pub warp_session_id: Option<String>,
    pub warp_terminal_session_uuid: Option<String>,
    pub iterm_session_id: Option<String>,
    pub wt_session: Option<String>,
    pub terminal_emulator: Option<String>,
    pub mlterm: Option<String>,
    /// `true` on Windows, where a missing `WT_SESSION` means the terminal is
    /// the legacy console host rather than a known one.
    pub is_windows: bool,
}

impl ProbeEnv {
    /// Read the current process environment.
    pub fn from_process() -> Self {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        Self {
            term: var("TERM"),
            term_program: var("TERM_PROGRAM"),
            colorterm: var("COLORTERM"),
            tmux: var("TMUX"),
            kitty_window_id: var("KITTY_WINDOW_ID"),
            ghostty_resources_dir: var("GHOSTTY_RESOURCES_DIR"),
            wezterm_pane: var("WEZTERM_PANE"),
            warp_session_id: var("WARP_SESSION_ID"),
            warp_terminal_session_uuid: var("WARP_TERMINAL_SESSION_UUID"),
            iterm_session_id: var("ITERM_SESSION_ID"),
            wt_session: var("WT_SESSION"),
            terminal_emulator: var("TERMINAL_EMULATOR"),
            mlterm: var("MLTERM"),
            is_windows: cfg!(windows),
        }
    }
}

fn lower(value: &Option<String>) -> String {
    value.as_deref().unwrap_or_default().to_ascii_lowercase()
}

/// Decide what the terminal can render.
///
/// Order and conditions mirror `detectCapabilitiesFromEnvironment` in
/// pi-tui. tmux and GNU screen are excluded up front: neither forwards image
/// graphics reliably, and a picture that half-renders is worse than a marker.
pub fn detect_capabilities(env: &ProbeEnv) -> TerminalCapabilities {
    let term = lower(&env.term);
    let term_program = lower(&env.term_program);
    let colorterm = lower(&env.colorterm);
    let true_color = colorterm == "truecolor" || colorterm == "24bit";

    let kitty = || TerminalCapabilities {
        images: Some(ImageProtocol::Kitty),
        true_color: true,
    };
    let iterm2 = || TerminalCapabilities {
        images: Some(ImageProtocol::Iterm2),
        true_color: true,
    };
    let sixel = || TerminalCapabilities {
        images: Some(ImageProtocol::Sixel),
        true_color: true,
    };
    let none = |tc: bool| TerminalCapabilities {
        images: None,
        true_color: tc,
    };

    if env.tmux.is_some() || term.starts_with("tmux") {
        return none(true_color);
    }
    if term.starts_with("screen") {
        return none(true_color);
    }
    if env.kitty_window_id.is_some() || term_program == "kitty" {
        return kitty();
    }
    if term_program == "ghostty" || term.contains("ghostty") || env.ghostty_resources_dir.is_some()
    {
        return kitty();
    }
    if env.wezterm_pane.is_some() || term_program == "wezterm" {
        return kitty();
    }
    if env.warp_session_id.is_some()
        || env.warp_terminal_session_uuid.is_some()
        || term_program == "warpterminal"
    {
        return kitty();
    }
    if env.iterm_session_id.is_some() || term_program == "iterm.app" {
        return iterm2();
    }
    if env.wt_session.is_some() {
        return sixel();
    }
    if term_program == "vscode" || term_program == "zed" {
        return none(true);
    }
    if term_program == "alacritty" {
        // Alacritty 0.13+ enables the sixel graphics protocol by default.
        return sixel();
    }
    // Sixel-capable terminals that identify themselves through TERM.
    if term.starts_with("foot")
        || term.starts_with("mlterm")
        || term.starts_with("yaft")
        || term.starts_with("contour")
        || term.starts_with("rio")
        || env.mlterm.is_some()
    {
        return sixel();
    }
    if lower(&env.terminal_emulator) == "jetbrains-jediterm" {
        return none(true);
    }
    // Windows Terminal does not always set WT_SESSION, for example when it
    // hosts a cmd.exe launched directly from Win+R. Modern Windows consoles
    // support truecolor; images stay off because the legacy console renders
    // nothing and guessing sixel would emit a DCS sequence it silently drops.
    if env.is_windows {
        return none(true);
    }
    none(true_color)
}

/// The protocol to use, honouring `PI_IMAGE_PROTOCOL` as pi-tui does so a user
/// can force or disable graphics without changing terminals.
///
/// The accepted values are the reference's, verbatim: `kitty` and `iterm2`
/// select a protocol, `none` and `0` disable images, and anything else —
/// including `sixel` — falls back to detection. `PI_IMAGE_PROTOCOL=sixel`
/// working here but not in pi-tui would make the two frontends disagree about
/// the escape sequences a terminal receives, which is the one thing this port
/// exists to prevent.
pub fn resolve_protocol(env: &ProbeEnv) -> Option<ImageProtocol> {
    let forced = std::env::var("PI_IMAGE_PROTOCOL")
        .ok()
        .map(|v| v.to_ascii_lowercase());
    match forced.as_deref() {
        Some("kitty") => Some(ImageProtocol::Kitty),
        Some("iterm2") => Some(ImageProtocol::Iterm2),
        Some("none" | "0") => None,
        Some(_) | None => detect_capabilities(env).images,
    }
}

/// How many terminal cells a picture occupies, given its pixel size and the
/// cell budget — the port of pi-tui's `calculateImageCellSize`.
///
/// `max_height_cells` is optional in the reference, where an absent height
/// means the width is the only binding constraint; Rust spells that `None`.
/// The cell measure itself defaults to [`DEFAULT_CELL_WIDTH_PX`] /
/// [`DEFAULT_CELL_HEIGHT_PX`] at the call sites.
pub fn calculate_image_cell_size(
    source_px: (u32, u32),
    max_width_cells: u32,
    max_height_cells: Option<u32>,
    cell_px: (u32, u32),
) -> CellSize {
    let cell_width = cell_px.0.max(1);
    let cell_height = cell_px.1.max(1);
    let max_width = max_width_cells.max(1);
    let max_height = max_height_cells.map(|value| value.max(1));
    let image_width = source_px.0.max(1);
    let image_height = source_px.1.max(1);

    let width_scale = f64::from(max_width * cell_width) / f64::from(image_width);
    let height_scale = match max_height {
        None => width_scale,
        Some(max_height) => f64::from(max_height * cell_height) / f64::from(image_height),
    };
    let scale = width_scale.min(height_scale);

    let columns = (f64::from(image_width) * scale / f64::from(cell_width)).ceil() as u32;
    let rows = (f64::from(image_height) * scale / f64::from(cell_height)).ceil() as u32;
    CellSize {
        columns: columns.max(1).min(max_width),
        rows: match max_height {
            None => rows.max(1),
            Some(max_height) => rows.max(1).min(max_height),
        },
    }
}

/// Encode a Kitty graphics image — the port of pi-tui's `encodeKitty`.
///
/// Kitty's `m=` flag means "more chunks follow": `m=1` on every chunk but the
/// last, `m=0` on the final one. The reference repeats the full parameter list
/// only on the first chunk (appending `m=1` to it) and sends the follow-ups
/// bare, so a port that repeats them would still produce a valid image but a
/// different byte stream — and `q=2` is what tells the terminal to stay silent
/// about the transmission.
pub fn encode_kitty(
    base64: &str,
    columns: u32,
    rows: u32,
    image_id: Option<u32>,
    move_cursor: bool,
) -> String {
    const CHUNK_SIZE: usize = 4096;

    let mut params: Vec<String> = vec!["a=T".to_string(), "f=100".to_string(), "q=2".to_string()];
    if !move_cursor {
        params.push("C=1".to_string());
    }
    if columns > 0 {
        params.push(format!("c={columns}"));
    }
    if rows > 0 {
        params.push(format!("r={rows}"));
    }
    if let Some(image_id) = image_id {
        params.push(format!("i={image_id}"));
    }
    let params = params.join(",");

    let payload = base64.as_bytes();
    if payload.is_empty() {
        return String::new();
    }
    if payload.len() <= CHUNK_SIZE {
        return format!("\x1b_G{params};{base64}\x1b\\");
    }

    let mut out = String::with_capacity(base64.len() + 128);
    let mut offset = 0usize;
    while offset < payload.len() {
        let end = (offset + CHUNK_SIZE).min(payload.len());
        let chunk = std::str::from_utf8(&payload[offset..end]).unwrap_or_default();
        if offset == 0 {
            out.push_str(&format!("\x1b_G{params},m=1;{chunk}\x1b\\"));
        } else if end >= payload.len() {
            out.push_str(&format!("\x1b_Gm=0;{chunk}\x1b\\"));
        } else {
            out.push_str(&format!("\x1b_Gm=1;{chunk}\x1b\\"));
        }
        offset = end;
    }
    out
}

/// Encode an iTerm2 inline image — the port of pi-tui's `encodeITerm2`.
///
/// `size` is the decoded byte length, not the base64 length: the reference
/// reads it back through `Buffer.byteLength(data, "base64")`, and a terminal
/// that trusts an inflated size waits for bytes that never arrive. Height is
/// `auto` so iTerm2 keeps the aspect ratio, and the sequence ends in BEL — not
/// ST — exactly as the reference emits it.
pub fn encode_iterm2(base64: &str, columns: u32) -> String {
    let mut params: Vec<String> = vec![
        "inline=1".to_string(),
        format!("size={}", base64_decoded_len(base64)),
    ];
    if columns > 0 {
        params.push(format!("width={columns}"));
    }
    params.push("height=auto".to_string());
    format!("\x1b]1337;File={}:{base64}\x07", params.join(";"))
}

/// The decoded byte length of a base64 payload.
fn base64_decoded_len(base64: &str) -> usize {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(base64)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(base64))
        .map(|decoded| decoded.len())
        .unwrap_or(base64.len() / 4 * 3)
}

/// Sixel palette geometry — verbatim from the reference: a 6x6x6 RGB cube with
/// a step of 51, followed by a 24-step grey ramp starting at 8. The cube
/// occupies indices 0..216 and the greys 216..240, the fixed set every sixel
/// terminal is required to provide.
const SIXEL_CUBE_STEP: u32 = 51;
const SIXEL_GRAY_BASE: u32 = 8;
const SIXEL_GRAY_STEP: u32 = 10;
const SIXEL_CUBE_LEN: usize = 216;
const SIXEL_PALETTE_LEN: usize = 240;

/// Sixel palette colour values are 0-100 percentages, not 0-255.
fn sixel_percent(value: u32) -> u32 {
    (value * 100 + 127) / 255
}

/// Build the `#<i>;2;<r>;<g>;<b>` definition for the whole 240-colour palette.
///
/// The reference declares every colour up front rather than only the ones the
/// image happens to use, so the byte stream does not depend on the pixel
/// content and a terminal never has to keep a colour map alive across blocks.
fn sixel_palette_declaration() -> String {
    let mut out = String::with_capacity(SIXEL_PALETTE_LEN * 18);
    for r in 0..6u32 {
        for g in 0..6u32 {
            for b in 0..6u32 {
                // (channel * 51 / 255) * 100 == channel * 20.
                out.push_str(&format!(
                    "#{};2;{};{};{}",
                    36 * r + 6 * g + b,
                    r * 20,
                    g * 20,
                    b * 20
                ));
            }
        }
    }
    for i in 0..24u32 {
        let level = sixel_percent(SIXEL_GRAY_BASE + i * SIXEL_GRAY_STEP);
        out.push_str(&format!(
            "#{};2;{level};{level};{level}",
            SIXEL_CUBE_LEN + i as usize
        ));
    }
    out
}

/// Quantize an RGB triple to the fixed 240-colour palette, returning the
/// palette index — the port of pi-tui's `quantizeSixelColor`.
///
/// Two candidates compete: the rounded per-channel cube bucket, and the grey
/// that matches the pixel's luminance. Grey wins only when it is strictly
/// closer, which is the reference's tie-break. Measuring distance one-sided
/// here would be invisible in review and very visible on screen: every colour
/// collapses onto the bright end of the ramp, which is exactly what the first
/// draft of this port did.
pub fn quantize_sixel_color(r: u8, g: u8, b: u8) -> usize {
    let (r, g, b) = (u32::from(r), u32::from(g), u32::from(b));
    let bucket = |value: u32| ((value * 5 + 127) / 255).min(5);
    let (ri, gi, bi) = (bucket(r), bucket(g), bucket(b));
    let cube = (36 * ri + 6 * gi + bi) as usize;
    let cube_dist = squared_distance(
        r,
        g,
        b,
        ri * SIXEL_CUBE_STEP,
        gi * SIXEL_CUBE_STEP,
        bi * SIXEL_CUBE_STEP,
    );

    let luminance = 0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b);
    let gray_step = ((luminance - f64::from(SIXEL_GRAY_BASE)) / f64::from(SIXEL_GRAY_STEP))
        .round()
        .clamp(0.0, 23.0) as u32;
    let gray = SIXEL_GRAY_BASE + gray_step * SIXEL_GRAY_STEP;
    let gray_dist = squared_distance(r, g, b, gray, gray, gray);

    if gray_dist < cube_dist {
        SIXEL_CUBE_LEN + gray_step as usize
    } else {
        cube
    }
}

/// Squared RGB distance in signed arithmetic. The reference subtracts without
/// clamping, so `saturating_sub` — which scores a palette entry *below* the
/// pixel as a perfect match — is not an equivalent rewrite.
fn squared_distance(r: u32, g: u32, b: u32, pr: u32, pg: u32, pb: u32) -> i64 {
    let dr = i64::from(r) - i64::from(pr);
    let dg = i64::from(g) - i64::from(pg);
    let db = i64::from(b) - i64::from(pb);
    dr * dr + dg * dg + db * db
}

/// Encode RGBA pixels as a sixel sequence — the port of pi-tui's
/// `encodeSixel`.
///
/// `pixels` is tightly packed RGBA8, row-major, `pixel_width` columns by
/// `pixel_height` rows. The picture is downsampled (nearest-neighbour) to the
/// cell budget and quantised to the fixed 240-colour palette, so the terminal
/// receives one self-contained block it can paint without further geometry.
/// `max_height_cells` is optional, as in the reference: an absent height lets
/// the width bind.
pub fn encode_sixel(
    pixels: &[u8],
    pixel_width: u32,
    pixel_height: u32,
    max_width_cells: u32,
    max_height_cells: Option<u32>,
    cell_px: (u32, u32),
) -> String {
    if pixel_width == 0 || pixel_height == 0 {
        return String::new();
    }
    if pixels.len() < (pixel_width as usize) * (pixel_height as usize) * 4 {
        return String::new();
    }

    let size = calculate_image_cell_size(
        (pixel_width, pixel_height),
        max_width_cells,
        max_height_cells,
        cell_px,
    );
    let target_width = (size.columns * cell_px.0.max(1)).max(1);
    let target_height = (size.rows * cell_px.1.max(1)).max(1);

    let mut out = String::with_capacity(SIXEL_PALETTE_LEN * 18 + target_width as usize * 8);
    // The whole palette, declared up front — the reference does not narrow the
    // declaration to the colours an image happens to use.
    out.push_str("\x1bPq");
    out.push_str(&sixel_palette_declaration());
    let bands = target_height.div_ceil(6);
    // One quantised colour per (column, row-in-band) — the emit pass reads a
    // whole pixel column off this, and `present` keeps the reference's
    // insertion order so the same picture always produces the same bytes.
    let mut colors: Vec<i64> = Vec::with_capacity(target_width as usize * 6);
    let mut present: Vec<usize> = Vec::new();
    for band in 0..bands {
        if band > 0 {
            out.push('-');
        }
        colors.clear();
        present.clear();
        // Sample the band at the picture's resolution: the first pass records
        // which colours exist, the second paints them.
        for tx in 0..target_width {
            let sx = (u64::from(tx) * u64::from(pixel_width) / u64::from(target_width))
                .min(u64::from(pixel_width) - 1) as u32;
            for row in 0..6u32 {
                let ty = band * 6 + row;
                if ty >= target_height {
                    // Past the last row of the picture: no colour, so the bit
                    // stays clear while the row keeps its slot.
                    colors.push(-1);
                    continue;
                }
                let sy = (u64::from(ty) * u64::from(pixel_height) / u64::from(target_height))
                    .min(u64::from(pixel_height) - 1) as u32;
                let offset = (sy as usize * pixel_width as usize + sx as usize) * 4;
                let color =
                    quantize_sixel_color(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
                colors.push(color as i64);
                if !present.contains(&color) {
                    present.push(color);
                }
            }
        }
        // A sixel character paints one pixel column across the band's six rows
        // in the selected colour (bit 0 = topmost row), so each colour present
        // is emitted as one run over every column — one character per column
        // with no repeat qualifier, exactly as the reference writes it.
        for color in &present {
            out.push_str(&format!("#{color}"));
            for tx in 0..target_width {
                let mut bits = 0u8;
                for row in 0..6usize {
                    if colors[tx as usize * 6 + row] == *color as i64 {
                        bits |= 1 << row;
                    }
                }
                out.push(char::from(63 + bits));
            }
        }
    }
    out.push_str("\x1b\\");
    out
}

/// Write `text` to `writer`, flushing so the terminal shows it immediately.
/// The REPL prints as it goes; buffering a picture would look like a hang.
pub fn write_block(writer: &mut dyn Write, text: &str) -> std::io::Result<()> {
    writer.write_all(text.as_bytes())?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_with(pairs: &[(&str, &str)]) -> ProbeEnv {
        let mut env = ProbeEnv {
            is_windows: false,
            ..ProbeEnv::default()
        };
        for (key, value) in pairs {
            let slot = match *key {
                "TERM" => &mut env.term,
                "TERM_PROGRAM" => &mut env.term_program,
                "COLORTERM" => &mut env.colorterm,
                "TMUX" => &mut env.tmux,
                "KITTY_WINDOW_ID" => &mut env.kitty_window_id,
                "WT_SESSION" => &mut env.wt_session,
                "ITERM_SESSION_ID" => &mut env.iterm_session_id,
                _ => continue,
            };
            *slot = Some((*value).to_string());
        }
        env
    }

    #[test]
    fn kitty_is_detected_from_its_window_id() {
        let caps = detect_capabilities(&env_with(&[("KITTY_WINDOW_ID", "1")]));
        assert_eq!(caps.images, Some(ImageProtocol::Kitty));
    }

    #[test]
    fn windows_terminal_is_sixel() {
        let caps = detect_capabilities(&env_with(&[("WT_SESSION", "abc")]));
        assert_eq!(caps.images, Some(ImageProtocol::Sixel));
    }

    #[test]
    fn iterm2_is_detected() {
        let caps = detect_capabilities(&env_with(&[("ITERM_SESSION_ID", "x")]));
        assert_eq!(caps.images, Some(ImageProtocol::Iterm2));
    }

    #[test]
    fn tmux_and_screen_never_get_images() {
        assert_eq!(
            detect_capabilities(&env_with(&[("TMUX", "/tmp/tmux-0/default")])).images,
            None
        );
        assert_eq!(
            detect_capabilities(&env_with(&[("TERM", "screen-256color")])).images,
            None
        );
    }

    #[test]
    fn vscode_embedded_terminal_gets_no_images() {
        assert_eq!(
            detect_capabilities(&env_with(&[("TERM_PROGRAM", "vscode")])).images,
            None
        );
    }

    #[test]
    fn windows_without_a_known_host_guesses_nothing() {
        let caps = detect_capabilities(&ProbeEnv {
            is_windows: true,
            ..ProbeEnv::default()
        });
        assert_eq!(caps.images, None);
    }

    #[test]
    fn cell_size_matches_the_reference_when_width_binds() {
        // 400x200 into 10x10 cells of 9x18 px: width binds, and the rows fall
        // out of the height the scaled picture occupies.
        let size = calculate_image_cell_size((400, 200), 10, Some(10), (9, 18));
        assert_eq!(size.columns, 10);
        assert_eq!(size.rows, 3);
    }

    #[test]
    fn cell_size_lets_height_bind_and_keeps_the_aspect() {
        // 10x100 cells of 9x18 px is 90x1800 px; a tall picture hits the height
        // cap first and must lose width, not squash.
        let size = calculate_image_cell_size((100, 1000), 10, Some(10), (9, 18));
        assert_eq!(size.columns, 2);
        assert_eq!(size.rows, 10);
    }

    #[test]
    fn cell_size_without_a_height_cap_lets_the_width_decide() {
        let size = calculate_image_cell_size((100, 1000), 10, None, (9, 18));
        assert_eq!(size.columns, 10);
        assert_eq!(size.rows, 50);
    }

    #[test]
    fn quantization_keeps_saturated_colours_apart() {
        // The regression this test exists for: a one-sided distance measure
        // scored every palette entry below a pixel as a perfect match, so red
        // and blue both came out as the same grey and the picture lost its
        // colours without losing any pixels.
        let red = quantize_sixel_color(255, 0, 0);
        let blue = quantize_sixel_color(0, 0, 255);
        assert_ne!(red, blue, "red and blue must not quantize to one entry");
        assert_eq!(red, 36 * 5, "red belongs to the cube entry (5,0,0)");
        assert_eq!(blue, 5, "blue belongs to the cube entry (0,0,5)");
    }

    /// Sixel data characters, excluding the introducer (`Pq`) and the
    /// terminator's backslash, which live in the same code range.
    fn painted_characters(sequence: &str) -> usize {
        sequence
            .chars()
            .filter(|c| matches!(c, '?'..='~' if *c != 'q' && *c != 'P' && *c != '\\'))
            .count()
    }

    #[test]
    fn kitty_encoding_chunks_the_payload() {
        let payload = "A".repeat(9000);
        let out = encode_kitty(&payload, 1, 4, Some(2), true);
        // 4096 + 4096 + 808 -> three chunks; the last one is final.
        assert_eq!(out.matches("\x1b_G").count(), 3);
        assert!(out.contains("m=0;"), "the final chunk must carry m=0");
        assert_eq!(out.matches("m=1;").count(), 2);
        assert!(
            out.starts_with("\x1b_Ga=T,f=100,q=2,c=1,r=4,i=2,m=1;"),
            "the first chunk carries the whole parameter list plus m=1, got {:?}",
            &out[..40.min(out.len())]
        );
    }

    #[test]
    fn kitty_single_chunk_carries_no_more_flag() {
        let out = encode_kitty("QUJD", 3, 2, None, true);
        assert_eq!(out, "\x1b_Ga=T,f=100,q=2,c=3,r=2;QUJD\x1b\\");
    }

    #[test]
    fn iterm2_encoding_carries_the_cell_size_and_decoded_length() {
        // QUJD decodes to ABC: three bytes, not the four base64 characters.
        let out = encode_iterm2("QUJD", 10);
        assert_eq!(
            out,
            "\x1b]1337;File=inline=1;size=3;width=10;height=auto:QUJD\u{7}"
        );
    }

    #[test]
    fn sixel_paints_pixels_instead_of_only_describing_the_palette() {
        // The regression this test exists for: header, palette and terminator
        // were all present while the pixel data was not, so every sixel
        // terminal rendered a blank block.
        let mut pixels = Vec::with_capacity(4 * 2 * 4);
        for _ in 0..2 {
            for x in 0..4 {
                let (r, b) = if x < 2 { (255, 0) } else { (0, 255) };
                pixels.extend_from_slice(&[r, 0, b, 255]);
            }
        }
        let out = encode_sixel(&pixels, 4, 2, 4, Some(2), (9, 18));
        assert!(out.starts_with("\x1bPq"), "must open the DCS introducer");
        assert!(out.ends_with("\x1b\\"), "must close the string terminator");
        assert!(out.contains('#'), "must select a palette colour");
        // 4x2 px into a 4x2 cell budget is 36x18 px: three six-row bands, so two
        // separators and none trailing.
        assert_eq!(out.matches('-').count(), 2);
        assert!(
            painted_characters(&out) > 0,
            "the sequence must paint pixels, not just declare a palette"
        );
    }

    #[test]
    fn sixel_refuses_a_short_buffer_rather_than_reading_past_it() {
        assert_eq!(encode_sixel(&[0, 0, 0], 64, 64, 8, Some(8), (9, 18)), "");
    }

    #[test]
    fn sixel_and_cell_size_match_the_pi_tui_reference() {
        let golden_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test/terminal-image-golden.json");
        let raw = std::fs::read_to_string(&golden_path).unwrap_or_else(|error| {
            panic!(
                "reference golden missing at {}: {error}\n\
                 Regenerate it with `bun scripts/gen-sixel-golden.mjs`.",
                golden_path.display()
            )
        });
        let golden: serde_json::Value =
            serde_json::from_str(&raw).expect("the golden file is valid JSON");

        let width = golden["widthPx"].as_u64().expect("widthPx") as u32;
        let height = golden["heightPx"].as_u64().expect("heightPx") as u32;
        let rgba: Vec<u8> = golden["rgba"]
            .as_array()
            .expect("rgba")
            .iter()
            .map(|channel| channel.as_u64().expect("channel") as u8)
            .collect();
        let max_width = golden["maxWidthCells"].as_u64().expect("maxWidthCells") as u32;
        let max_height = golden["maxHeightCells"].as_u64().expect("maxHeightCells") as u32;
        let cell_px = (DEFAULT_CELL_WIDTH_PX, DEFAULT_CELL_HEIGHT_PX);

        let size = calculate_image_cell_size((width, height), max_width, Some(max_height), cell_px);
        assert_eq!(
            u64::from(size.columns),
            golden["cellSize"]["columns"].as_u64().expect("columns"),
            "cell columns drifted from pi-tui's calculateImageCellSize"
        );
        assert_eq!(
            u64::from(size.rows),
            golden["cellSize"]["rows"].as_u64().expect("rows"),
            "cell rows drifted from pi-tui's calculateImageCellSize"
        );

        let sequence = encode_sixel(&rgba, width, height, max_width, Some(max_height), cell_px);
        let expected = golden["sequence"].as_str().expect("sequence");
        assert_eq!(
            sequence.len(),
            expected.len(),
            "the sixel sequence length drifted from pi-tui's encodeSixel"
        );
        assert!(
            sequence == expected,
            "the sixel sequence drifted from pi-tui's encodeSixel"
        );
    }
}
