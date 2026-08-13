//! Terminal inline-image rendering (TS `pi-tui/src/terminal-image.ts` parity).
//!
//! Detects the terminal's image protocol (Kitty graphics / iTerm2 inline),
//! parses image dimensions straight from base64-encoded data (PNG / JPEG /
//! GIF / WEBP), sizes the image against the terminal cell grid, and builds
//! the escape sequences that draw it inline.
//!
//! These sequences contain control characters (ESC / BEL / ST), so they must
//! be written to the terminal **directly** — ratatui strips control
//! characters out of cell symbols, so they can never pass through a
//! `Paragraph`/buffer path unchanged. See `chatwidget` for the injection.

/// Image protocol a terminal supports, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageProtocol {
    /// Kitty graphics protocol (`\x1b_G…`).
    Kitty,
    /// iTerm2 inline images (`\x1b]1337;File=…`).
    ITerm2,
}

/// What the attached terminal advertises (via environment hints).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalCapabilities {
    pub images: Option<ImageProtocol>,
    pub true_color: bool,
    pub hyperlinks: bool,
}

/// Pixel dimensions of an image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageDimensions {
    pub width_px: u32,
    pub height_px: u32,
}

/// Pixel size of one terminal cell (updated by the TUI when it queries the
/// terminal; defaults to 9×18 like TS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellDimensions {
    pub width_px: u32,
    pub height_px: u32,
}

/// Options controlling how an image is rendered.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderOptions {
    /// Cap the image width in terminal cells (default 80 like TS `renderImage`).
    pub max_width_cells: Option<u16>,
    /// Cap the image height in terminal cells (unbounded when `None`).
    pub max_height_cells: Option<u16>,
    /// iTerm2: keep the aspect ratio when only the width is fixed.
    pub preserve_aspect_ratio: bool,
    /// Kitty image id — reuses/replaces the image carrying this id.
    pub image_id: Option<u32>,
    /// Whether Kitty should apply its default cursor movement after placement.
    pub move_cursor: bool,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            max_width_cells: None,
            max_height_cells: None,
            preserve_aspect_ratio: true,
            image_id: None,
            move_cursor: false,
        }
    }
}

/// A rendered inline image: the escape sequence plus the terminal rows it
/// occupies (so the transcript can reserve that much space).
#[derive(Debug, Clone, PartialEq)]
pub struct RenderedImage {
    pub sequence: String,
    pub rows: u16,
    pub image_id: Option<u32>,
    /// Which protocol the sequence targets (drives cleanup / re-placement).
    pub protocol: ImageProtocol,
}

/// Default cell dimensions when the terminal hasn't been queried yet.
pub const DEFAULT_CELL_DIMENSIONS: CellDimensions = CellDimensions {
    width_px: 9,
    height_px: 18,
};

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

fn env_lower(name: &str) -> String {
    std::env::var(name).unwrap_or_default().to_lowercase()
}

fn env_set(name: &str) -> bool {
    std::env::var_os(name).is_some()
}

/// Detect terminal capabilities from environment hints (TS
/// `detectCapabilities` parity, without the tmux hyperlink probe — the Rust
/// transcript renderer doesn't emit OSC 8 hyperlinks).
///
/// Image protocols are deliberately left off under tmux/screen and for
/// unknown terminals (conservative — the escape noise would corrupt output
/// where it isn't supported).
pub fn detect_capabilities() -> TerminalCapabilities {
    let term_program = env_lower("TERM_PROGRAM");
    let terminal_emulator = env_lower("TERMINAL_EMULATOR");
    let term = env_lower("TERM");
    let color_term = env_lower("COLORTERM");
    let has_true_color_hint = color_term == "truecolor" || color_term == "24bit";

    // tmux only forwards image/OSC sequences when its client supports them;
    // without a live probe we can't tell, so stay off (TS parity).
    if env_set("TMUX") || term.starts_with("tmux") {
        return TerminalCapabilities {
            images: None,
            true_color: has_true_color_hint,
            hyperlinks: false,
        };
    }
    // screen does not forward hyperlinks and is opaque about graphics.
    if term.starts_with("screen") {
        return TerminalCapabilities {
            images: None,
            true_color: has_true_color_hint,
            hyperlinks: false,
        };
    }

    let kitty = TerminalCapabilities {
        images: Some(ImageProtocol::Kitty),
        true_color: true,
        hyperlinks: true,
    };
    let iterm2 = TerminalCapabilities {
        images: Some(ImageProtocol::ITerm2),
        true_color: true,
        hyperlinks: true,
    };

    if env_set("KITTY_WINDOW_ID") || term_program == "kitty" {
        return kitty;
    }
    if term_program == "ghostty" || term.contains("ghostty") || env_set("GHOSTTY_RESOURCES_DIR") {
        return kitty;
    }
    if env_set("WEZTERM_PANE") || term_program == "wezterm" {
        return kitty;
    }
    // Warp supports the Kitty graphics protocol.
    if term_program == "warpterminal"
        || env_set("WARP_SESSION_ID")
        || env_set("WARP_TERMINAL_SESSION_UUID")
    {
        return kitty;
    }
    if env_set("ITERM_SESSION_ID") || term_program == "iterm.app" {
        return iterm2;
    }
    if env_set("WT_SESSION") {
        return TerminalCapabilities {
            images: None,
            true_color: true,
            hyperlinks: true,
        };
    }
    if term_program == "vscode" {
        return TerminalCapabilities {
            images: None,
            true_color: true,
            hyperlinks: true,
        };
    }
    if term_program == "alacritty" {
        return TerminalCapabilities {
            images: None,
            true_color: true,
            hyperlinks: true,
        };
    }
    if terminal_emulator == "jetbrains-jediterm" {
        return TerminalCapabilities {
            images: None,
            true_color: true,
            hyperlinks: false,
        };
    }

    // Unknown terminal: stay conservative.
    TerminalCapabilities {
        images: None,
        true_color: has_true_color_hint,
        hyperlinks: false,
    }
}

/// Cached capabilities (TS `getCapabilities` parity).
static CAPS_CACHE: std::sync::Mutex<Option<TerminalCapabilities>> = std::sync::Mutex::new(None);

pub fn get_capabilities() -> TerminalCapabilities {
    let mut guard = CAPS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(caps) = *guard {
        return caps;
    }
    let caps = detect_capabilities();
    *guard = Some(caps);
    caps
}

pub fn reset_capabilities_cache() {
    if let Ok(mut guard) = CAPS_CACHE.lock() {
        *guard = None;
    }
}

/// Override the cached capabilities (useful in tests to exercise both
/// protocol paths; TS `setCapabilities` parity).
pub fn set_capabilities(caps: TerminalCapabilities) {
    if let Ok(mut guard) = CAPS_CACHE.lock() {
        *guard = Some(caps);
    }
}

/// Serialize tests that mutate the global capability cache. Cargo runs
/// tests in parallel threads, so a bare set→render→restore in one test
/// races with another test's `set_capabilities` and reads a stale protocol.
#[cfg(test)]
pub(crate) fn with_caps_lock<T>(f: impl FnOnce() -> T) -> T {
    static TEST_CAPS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = TEST_CAPS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

// ---------------------------------------------------------------------------
// Image dimension parsing (base64 in, pixels out)
// ---------------------------------------------------------------------------

/// Decode a standard base64 payload; `None` when malformed.
fn decode_base64(b64: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

fn read_u16_be(buf: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes([buf[offset], buf[offset + 1]])
}

fn read_u16_le(buf: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([buf[offset], buf[offset + 1]])
}

fn read_u32_le(buf: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        buf[offset],
        buf[offset + 1],
        buf[offset + 2],
        buf[offset + 3],
    ])
}

/// PNG: signature at 0..4, width/height (big-endian) at 16/20.
pub fn get_png_dimensions(b64: &str) -> Option<ImageDimensions> {
    let buf = decode_base64(b64)?;
    if buf.len() < 24 || buf[0] != 0x89 || buf[1] != 0x50 || buf[2] != 0x4e || buf[3] != 0x47 {
        return None;
    }
    Some(ImageDimensions {
        width_px: read_u32_be(&buf, 16),
        height_px: read_u32_be(&buf, 20),
    })
}

/// JPEG: walk segment markers until a SOF0/1/2 frame header.
pub fn get_jpeg_dimensions(b64: &str) -> Option<ImageDimensions> {
    let buf = decode_base64(b64)?;
    if buf.len() < 2 || buf[0] != 0xff || buf[1] != 0xd8 {
        return None;
    }
    let mut offset = 2usize;
    while offset + 9 < buf.len() {
        if buf[offset] != 0xff {
            offset += 1;
            continue;
        }
        let marker = buf[offset + 1];
        if (0xc0..=0xc2).contains(&marker) {
            return Some(ImageDimensions {
                height_px: read_u16_be(&buf, offset + 5) as u32,
                width_px: read_u16_be(&buf, offset + 7) as u32,
            });
        }
        if offset + 3 >= buf.len() {
            return None;
        }
        let length = read_u16_be(&buf, offset + 2);
        if length < 2 {
            return None;
        }
        offset += 2 + length as usize;
    }
    None
}

/// GIF: "GIF87a"/"GIF89a" at 0..6, width/height (little-endian) at 6/8.
pub fn get_gif_dimensions(b64: &str) -> Option<ImageDimensions> {
    let buf = decode_base64(b64)?;
    if buf.len() < 10 {
        return None;
    }
    let sig = &buf[0..6];
    if sig != b"GIF87a" && sig != b"GIF89a" {
        return None;
    }
    Some(ImageDimensions {
        width_px: read_u16_le(&buf, 6) as u32,
        height_px: read_u16_le(&buf, 8) as u32,
    })
}

/// WEBP: RIFF/WEBP container + the VP8 / VP8L / VP8X chunk header.
pub fn get_webp_dimensions(b64: &str) -> Option<ImageDimensions> {
    let buf = decode_base64(b64)?;
    if buf.len() < 30 || &buf[0..4] != b"RIFF" || &buf[8..12] != b"WEBP" {
        return None;
    }
    let chunk = &buf[12..16];
    if chunk == b"VP8 " {
        return Some(ImageDimensions {
            width_px: (read_u16_le(&buf, 26) & 0x3fff) as u32,
            height_px: (read_u16_le(&buf, 28) & 0x3fff) as u32,
        });
    }
    if chunk == b"VP8L" {
        if buf.len() < 25 {
            return None;
        }
        let bits = read_u32_le(&buf, 21);
        return Some(ImageDimensions {
            width_px: (bits & 0x3fff) + 1,
            height_px: ((bits >> 14) & 0x3fff) + 1,
        });
    }
    if chunk == b"VP8X" {
        let width = (u32::from(buf[24]) | (u32::from(buf[25]) << 8) | (u32::from(buf[26]) << 16))
            + 1;
        let height =
            (u32::from(buf[27]) | (u32::from(buf[28]) << 8) | (u32::from(buf[29]) << 16)) + 1;
        return Some(ImageDimensions {
            width_px: width,
            height_px: height,
        });
    }
    None
}

fn read_u32_be(buf: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes([
        buf[offset],
        buf[offset + 1],
        buf[offset + 2],
        buf[offset + 3],
    ])
}

/// Dimensions for a base64 payload of `mime`; `None` when the format is
/// unknown or the header is unreadable (TS `getImageDimensions` parity).
pub fn get_image_dimensions(b64: &str, mime: &str) -> Option<ImageDimensions> {
    match mime {
        "image/png" => get_png_dimensions(b64),
        "image/jpeg" => get_jpeg_dimensions(b64),
        "image/gif" => get_gif_dimensions(b64),
        "image/webp" => get_webp_dimensions(b64),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Cell-size calculation
// ---------------------------------------------------------------------------

/// Fit an image into the terminal cell grid, preserving aspect ratio, capped
/// by `max_width_cells`/`max_height_cells`. Returns `(columns, rows)` — both
/// at least 1 (TS `calculateImageCellSize` parity).
pub fn calculate_image_cell_size(
    image: ImageDimensions,
    max_width_cells: u16,
    max_height_cells: Option<u16>,
    cell: CellDimensions,
) -> (u16, u16) {
    let max_width = f64::from(max_width_cells.max(1));
    let max_height = max_height_cells.map(|h| f64::from(h.max(1)));
    let image_width = f64::from(image.width_px.max(1));
    let image_height = f64::from(image.height_px.max(1));

    let width_scale = max_width * f64::from(cell.width_px) / image_width;
    let height_scale = match max_height {
        Some(h) => h * f64::from(cell.height_px) / image_height,
        None => width_scale,
    };
    let scale = width_scale.min(height_scale);

    let scaled_width = image_width * scale;
    let scaled_height = image_height * scale;
    let columns = (scaled_width / f64::from(cell.width_px)).ceil();
    let rows = (scaled_height / f64::from(cell.height_px)).ceil();

    let columns = columns.clamp(1.0, max_width) as u16;
    let rows = match max_height {
        Some(h) => rows.clamp(1.0, h) as u16,
        None => rows.max(1.0) as u16,
    };
    (columns, rows)
}

/// Terminal rows an image needs at `target_width_cells` wide (TS
/// `calculateImageRows` parity).
pub fn calculate_image_rows(
    image: ImageDimensions,
    target_width_cells: u16,
    cell: CellDimensions,
) -> u16 {
    calculate_image_cell_size(image, target_width_cells, None, cell).1
}

// ---------------------------------------------------------------------------
// Escape-sequence encoding
// ---------------------------------------------------------------------------

/// Kitty graphics transmission chunk size (TS `CHUNK_SIZE`).
const KITTY_CHUNK_SIZE: usize = 4096;

/// `\x1b_G…` — the shared prefix of every Kitty graphics control.
const KITTY_PREFIX: &str = "\x1b_G";
/// `\x1b]1337;File=` — the iTerm2 inline-image prefix.
const ITERM2_PREFIX: &str = "\x1b]1337;File=";

/// Whether a rendered line is an inline-image escape sequence (TS
/// `isImageLine` parity — used to skip text wrapping for image rows).
pub fn is_image_line(line: &str) -> bool {
    line.starts_with(KITTY_PREFIX)
        || line.starts_with(ITERM2_PREFIX)
        || line.contains(KITTY_PREFIX)
        || line.contains(ITERM2_PREFIX)
}

/// Generate a random image id for the Kitty graphics protocol (TS
/// `allocateImageId` parity — random to avoid collisions between instances).
pub fn allocate_image_id() -> u32 {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    hasher.write_u128(nanos);
    let id = hasher.finish() as u32;
    // Range [1, u32::MAX] so 0 never reads as "no id".
    id.max(1)
}

#[derive(Debug, Clone, Default)]
pub struct KittyOptions {
    pub columns: Option<u16>,
    pub rows: Option<u16>,
    pub image_id: Option<u32>,
    /// Whether Kitty applies its default cursor movement after placement.
    pub move_cursor: bool,
}

/// Encode `base64_data` as a Kitty graphics transmission (`a=T`). Payloads
/// longer than the chunk size are split into a `m=1`/`m=0` multi-chunk
/// stream (TS `encodeKitty` parity).
pub fn encode_kitty(base64_data: &str, options: KittyOptions) -> String {
    let mut params: Vec<String> = vec!["a=T".into(), "f=100".into(), "q=2".into()];
    if !options.move_cursor {
        params.push("C=1".into());
    }
    if let Some(columns) = options.columns {
        params.push(format!("c={columns}"));
    }
    if let Some(rows) = options.rows {
        params.push(format!("r={rows}"));
    }
    if let Some(id) = options.image_id {
        params.push(format!("i={id}"));
    }
    let header = format!("{KITTY_PREFIX}{}", params.join(","));

    if base64_data.len() <= KITTY_CHUNK_SIZE {
        return format!("{header};{base64_data}\x1b\\");
    }

    let mut out = String::new();
    let mut offset = 0usize;
    let mut first = true;
    while offset < base64_data.len() {
        let end = (offset + KITTY_CHUNK_SIZE).min(base64_data.len());
        let chunk = &base64_data[offset..end];
        let is_last = end >= base64_data.len();
        if first {
            out.push_str(&format!("{header},m=1;{chunk}\x1b\\"));
            first = false;
        } else if is_last {
            out.push_str(&format!("\x1b_Gm=0;{chunk}\x1b\\"));
        } else {
            out.push_str(&format!("\x1b_Gm=1;{chunk}\x1b\\"));
        }
        offset = end;
    }
    out
}

/// Delete a Kitty graphics image by id (uppercase `I` also frees the data).
pub fn delete_kitty_image(image_id: u32) -> String {
    format!("\x1b_Ga=d,d=I,i={image_id},q=2\x1b\\")
}

/// Delete all visible Kitty graphics images (uppercase `A` frees the data).
pub fn delete_all_kitty_images() -> String {
    "\x1b_Ga=d,d=A,q=2\x1b\\".to_string()
}

#[derive(Debug, Clone, Default)]
pub struct ITerm2Options {
    pub width: Option<String>,
    pub height: Option<String>,
    pub name: Option<String>,
    pub preserve_aspect_ratio: bool,
    pub inline: bool,
}

/// Encode `base64_data` as an iTerm2 inline image (TS `encodeITerm2` parity).
pub fn encode_iterm2(base64_data: &str, options: ITerm2Options) -> String {
    use base64::Engine;
    let mut params: Vec<String> = vec![format!("inline={}", if options.inline { 1 } else { 0 })];
    if let Some(width) = options.width {
        params.push(format!("width={width}"));
    }
    if let Some(height) = options.height {
        params.push(format!("height={height}"));
    }
    if let Some(name) = options.name {
        let name_b64 = base64::engine::general_purpose::STANDARD.encode(name.as_bytes());
        params.push(format!("name={name_b64}"));
    }
    if !options.preserve_aspect_ratio {
        params.push("preserveAspectRatio=0".into());
    }
    format!("{ITERM2_PREFIX}{}:{base64_data}\x07", params.join(";"))
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/// Render `base64_data` inline for the detected terminal protocol. `None`
/// when the terminal doesn't support inline images (callers fall back to a
/// text summary — TS `renderImage` parity).
pub fn render_image(
    base64_data: &str,
    dimensions: ImageDimensions,
    options: RenderOptions,
) -> Option<RenderedImage> {
    let protocol = get_capabilities().images?;
    let max_width = options.max_width_cells.unwrap_or(80);
    let (columns, rows) = calculate_image_cell_size(
        dimensions,
        max_width,
        options.max_height_cells,
        DEFAULT_CELL_DIMENSIONS,
    );

    match protocol {
        ImageProtocol::Kitty => {
            let sequence = encode_kitty(
                base64_data,
                KittyOptions {
                    columns: Some(columns),
                    rows: Some(rows),
                    image_id: options.image_id,
                    move_cursor: options.move_cursor,
                },
            );
            Some(RenderedImage {
                sequence,
                rows,
                image_id: options.image_id,
                protocol: ImageProtocol::Kitty,
            })
        }
        ImageProtocol::ITerm2 => {
            let sequence = encode_iterm2(
                base64_data,
                ITerm2Options {
                    width: Some(columns.to_string()),
                    height: Some("auto".into()),
                    name: None,
                    preserve_aspect_ratio: options.preserve_aspect_ratio,
                    inline: true,
                },
            );
            Some(RenderedImage {
                sequence,
                rows,
                image_id: None,
                protocol: ImageProtocol::ITerm2,
            })
        }
    }
}

/// Plain-text placeholder for an image that can't be drawn inline (TS
/// `imageFallback` parity).
pub fn image_fallback(mime: &str, dimensions: Option<ImageDimensions>, filename: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(filename) = filename {
        parts.push(filename.to_string());
    }
    parts.push(format!("[{mime}]"));
    if let Some(dim) = dimensions {
        parts.push(format!("{}x{}", dim.width_px, dim.height_px));
    }
    format!("[Image: {}]", parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode raw bytes to a standard base64 string (the API's input shape).
    fn b64(bytes: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// A minimal real-ish PNG header (1×1).
    fn png_bytes() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
            0x00, 0x00, 0x00, 0x01, // width = 1
            0x00, 0x00, 0x00, 0x01, // height = 1
        ]
    }

    #[test]
    fn png_dimensions_parse_from_base64() {
        let dims = get_png_dimensions(&b64(&png_bytes())).expect("png dims");
        assert_eq!(dims, ImageDimensions { width_px: 1, height_px: 1 });
        assert!(get_png_dimensions(&b64(b"not a png")).is_none());
        assert!(get_png_dimensions("!!!invalid base64!!!").is_none());
    }

    #[test]
    fn jpeg_dimensions_walk_markers() {
        // SOI + APP0 (length 16) + SOF0 with 300x120 (length 11: precision
        // + height + width + 1 component). The walker needs 9 bytes past a
        // marker to read the frame header, so the buffer must stay ≥ 30.
        let mut jpeg = vec![0xff, 0xd8];
        jpeg.extend_from_slice(&[0xff, 0xe0]); // APP0
        jpeg.extend_from_slice(&[0x00, 0x10]); // length 16
        jpeg.extend_from_slice(&[0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
        jpeg.extend_from_slice(&[0xff, 0xc0]); // SOF0
        jpeg.extend_from_slice(&[0x00, 0x0b, 0x08]); // length + precision
        jpeg.extend_from_slice(&[0x00, 0x78]); // height 120
        jpeg.extend_from_slice(&[0x01, 0x2c]); // width 300
        jpeg.extend_from_slice(&[0x01, 0x00, 0x11, 0x00]); // 1 component
        let dims = get_jpeg_dimensions(&b64(&jpeg)).expect("jpeg dims");
        assert_eq!(dims, ImageDimensions { width_px: 300, height_px: 120 });
        assert!(get_jpeg_dimensions(&b64(b"\xff\xd8garbage")).is_none());
        assert!(get_jpeg_dimensions(&b64(b"not jpeg")).is_none());
    }

    #[test]
    fn gif_dimensions_parse() {
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&[0x40, 0x01, 0xf0, 0x00]); // 320x240 LE
        let dims = get_gif_dimensions(&b64(&gif)).expect("gif dims");
        assert_eq!(dims, ImageDimensions { width_px: 320, height_px: 240 });
        assert!(get_gif_dimensions(&b64(b"GIF89a")).is_none());
        assert!(get_gif_dimensions(&b64(b"PNGDATA")).is_none());
    }

    #[test]
    fn webp_dimensions_parse_vp8() {
        // RIFF + WEBP + "VP8 " lossy header. The frame tag sits at 16-19
        // (chunk size), width/height (LE) at 26/28 — TS parity.
        let mut webp = vec![0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
        webp.extend_from_slice(b"VP8 ");
        webp.extend_from_slice(&[0; 10]);
        webp.extend_from_slice(&[0x9d, 0x01]); // width 413 LE
        webp.extend_from_slice(&[0x2a, 0x01]); // height 298 LE
        let dims = get_webp_dimensions(&b64(&webp)).expect("webp dims");
        assert_eq!(dims, ImageDimensions { width_px: 413, height_px: 298 });
        assert!(get_webp_dimensions(&b64(b"RIFFXXXXWEBP")).is_none());
    }

    #[test]
    fn dispatch_by_mime() {
        assert_eq!(
            get_image_dimensions(&b64(&png_bytes()), "image/png"),
            Some(ImageDimensions { width_px: 1, height_px: 1 })
        );
        assert_eq!(get_image_dimensions(&b64(&png_bytes()), "image/webp"), None);
        assert_eq!(get_image_dimensions(&b64(&png_bytes()), "image/bmp"), None);
    }

    #[test]
    fn cell_size_caps_width_and_height() {
        let image = ImageDimensions { width_px: 800, height_px: 600 };
        let cell = DEFAULT_CELL_DIMENSIONS;
        // No height cap: proportional to width.
        let (cols, rows) = calculate_image_cell_size(image, 80, None, cell);
        assert_eq!(cols, 80);
        assert!(rows > 0);
        // Height cap overrides: square-ish image squeezed to the height cap.
        let (cols2, rows2) = calculate_image_cell_size(image, 80, Some(10), cell);
        assert_eq!(rows2, 10);
        assert!(cols2 <= cols, "height cap must shrink width too");
        // Degenerate inputs degrade to 1x1 rather than looping/zero.
        let (c, r) = calculate_image_cell_size(
            ImageDimensions { width_px: 0, height_px: 0 },
            0,
            None,
            cell,
        );
        assert!(c >= 1 && r >= 1);
    }

    #[test]
    fn kitty_single_chunk_encodes_header_and_st() {
        with_caps_lock(|| {
            set_capabilities(TerminalCapabilities {
                images: Some(ImageProtocol::Kitty),
                true_color: true,
                hyperlinks: true,
            });
            let seq = encode_kitty(
                "aGVsbG8=",
                KittyOptions {
                    columns: Some(40),
                    rows: Some(10),
                    image_id: Some(7),
                    move_cursor: false,
                },
            );
            assert!(seq.starts_with("\x1b_Ga=T,f=100,q=2,C=1,c=40,r=10,i=7;"), "{seq}");
            assert!(seq.ends_with("\x1b\\"), "{seq}");
            assert_eq!(seq, "\x1b_Ga=T,f=100,q=2,C=1,c=40,r=10,i=7;aGVsbG8=\x1b\\");
        });
    }

    #[test]
    fn kitty_large_payload_chunks_with_m_flags() {
        with_caps_lock(|| {
            set_capabilities(TerminalCapabilities {
                images: Some(ImageProtocol::Kitty),
                true_color: true,
                hyperlinks: true,
            });
            let big = "A".repeat(KITTY_CHUNK_SIZE + 10);
            let seq = encode_kitty(&big, KittyOptions { move_cursor: true, ..Default::default() });
            // The first chunk carries the full header with the m=1 flag.
            assert!(seq.starts_with("\x1b_Ga=T,f=100,q=2,m=1;"), "{seq}");
            assert!(seq.contains(",m=1;"), "{seq}");
            assert!(seq.contains("\x1b_Gm=0;"), "{seq}");
            assert!(seq.ends_with("\x1b\\"), "{seq}");
        });
    }

    #[test]
    fn iterm2_encodes_inline_file() {
        with_caps_lock(|| {
            set_capabilities(TerminalCapabilities {
                images: Some(ImageProtocol::ITerm2),
                true_color: true,
                hyperlinks: true,
            });
            let seq = encode_iterm2(
                "aGVsbG8=",
                ITerm2Options {
                    width: Some("40".into()),
                    height: Some("auto".into()),
                    inline: true,
                    preserve_aspect_ratio: true,
                    ..Default::default()
                },
            );
            assert_eq!(seq, "\x1b]1337;File=inline=1;width=40;height=auto:aGVsbG8=\x07");
        });
    }

    #[test]
    fn render_image_returns_none_without_protocol() {
        with_caps_lock(|| {
            set_capabilities(TerminalCapabilities {
                images: None,
                true_color: false,
                hyperlinks: false,
            });
            let dims = ImageDimensions { width_px: 800, height_px: 600 };
            assert!(render_image("aGVsbG8=", dims, RenderOptions::default()).is_none());
        });
    }

    #[test]
    fn render_image_picks_protocol_and_reserves_rows() {
        with_caps_lock(|| {
            set_capabilities(TerminalCapabilities {
                images: Some(ImageProtocol::Kitty),
                true_color: true,
                hyperlinks: true,
            });
            let dims = ImageDimensions { width_px: 800, height_px: 600 };
            let rendered = render_image(
                "aGVsbG8=",
                dims,
                RenderOptions { max_width_cells: Some(80), ..Default::default() },
            )
            .expect("renders under kitty");
            assert!(rendered.sequence.starts_with("\x1b_G"), "{}", rendered.sequence);
            assert!(rendered.rows >= 1);
        });
    }

    #[test]
    fn image_line_detection() {
        assert!(is_image_line("\x1b_Ga=T;aaa\x1b\\"));
        assert!(is_image_line("x\x1b]1337;File=inline=1:aaa\x07"));
        assert!(!is_image_line("plain text"));
    }

    #[test]
    fn fallback_formats_like_ts() {
        assert_eq!(
            image_fallback(
                "image/png",
                Some(ImageDimensions { width_px: 800, height_px: 600 }),
                Some("a.png"),
            ),
            "[Image: a.png [image/png] 800x600]"
        );
        assert_eq!(image_fallback("image/png", None, None), "[Image: [image/png]]");
    }

    #[test]
    fn delete_sequences_match_protocol() {
        assert_eq!(delete_kitty_image(7), "\x1b_Ga=d,d=I,i=7,q=2\x1b\\");
        assert_eq!(delete_all_kitty_images(), "\x1b_Ga=d,d=A,q=2\x1b\\");
    }

    #[test]
    fn capability_detection_honors_known_terminals() {
        // Guarded by env mutation: set & restore around each case.
        struct EnvGuard(Vec<(&'static str, Option<std::ffi::OsString>)>);
        impl EnvGuard {
            fn set(entries: &[(&'static str, &str)]) -> Self {
                let saved: Vec<_> = entries
                    .iter()
                    .map(|(name, value)| {
                        let old = std::env::var_os(name);
                        std::env::set_var(name, value);
                        (*name, old)
                    })
                    .collect();
                Self(saved)
            }
        }
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                for (name, old) in &self.0 {
                    match old {
                        Some(v) => std::env::set_var(name, v),
                        None => std::env::remove_var(name),
                    }
                }
            }
        }

        let _g = EnvGuard::set(&[("KITTY_WINDOW_ID", "1")]);
        assert_eq!(detect_capabilities().images, Some(ImageProtocol::Kitty));

        drop(_g);
        let _g = EnvGuard::set(&[("ITERM_SESSION_ID", "x")]);
        assert_eq!(detect_capabilities().images, Some(ImageProtocol::ITerm2));

        drop(_g);
        let _g = EnvGuard::set(&[("TERM", "xterm-256color")]);
        assert_eq!(detect_capabilities().images, None);

        drop(_g);
        let _g = EnvGuard::set(&[("TMUX", "1"), ("KITTY_WINDOW_ID", "1")]);
        // tmux wins over the kitty hint — conservative.
        assert_eq!(detect_capabilities().images, None);
    }
}
