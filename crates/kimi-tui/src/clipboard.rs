//! Clipboard image paste (TS `clipboard-image` / `extractMediaAttachments`
//! parity, simplified). Pasting reads a clipboard image into a temp file
//! and inserts a `[image #N]` placeholder into the input; submission
//! expands placeholders into `image_url` content parts the engine's
//! `prompt_parts` accepts. The pure functions are unit-testable; the
//! clipboard read itself shells out to PowerShell on Windows.
//!
//! Format handling differs from TS where the Rust side has no image
//! library: PNG/JPEG/GIF/BMP are detected by magic bytes and persisted
//! as-is (no re-encode, no paste-time compression), dimensions come from
//! minimal header parsing, and WebP is not supported (the Windows
//! clipboard never produces it). EXIF orientation is not applied — the
//! reported size is the raw header size, exactly like TS `parseImageMeta`
//! (TS applies orientation inside its SDK compression step, which the
//! Rust paste path does not have).

use std::path::PathBuf;

/// A pasted image attachment referenced by `[image #N]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageAttachment {
    pub id: usize,
    pub path: PathBuf,
    pub mime: String,
}

/// Image formats the paste pipeline detects and persists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Bmp,
}

impl ImageFormat {
    /// MIME type for the format (TS `SUPPORTED_IMAGE_MIME_TYPES` parity).
    pub fn mime(self) -> &'static str {
        match self {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::Gif => "image/gif",
            ImageFormat::Bmp => "image/bmp",
        }
    }

    /// File extension used when persisting the paste.
    pub fn extension(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpg",
            ImageFormat::Gif => "gif",
            ImageFormat::Bmp => "bmp",
        }
    }
}

/// Sniff the image format from magic bytes (TS `parseImageMeta` parity,
/// minus WebP — the Windows clipboard never produces it).
pub fn detect_image_format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.len() >= 8 && bytes[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some(ImageFormat::Png);
    }
    if bytes.len() >= 3 && bytes[..2] == [0xff, 0xd8] && bytes[2] == 0xff {
        return Some(ImageFormat::Jpeg);
    }
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        return Some(ImageFormat::Gif);
    }
    if bytes.len() >= 2 && bytes[..2] == [b'B', b'M'] {
        return Some(ImageFormat::Bmp);
    }
    None
}

/// Minimal header parsing for image dimensions (TS `parseImageMeta`
/// parity). Returns `None` when the bytes are truncated or the header is
/// unreadable; a failed parse must not block the paste.
pub fn image_dimensions(format: ImageFormat, bytes: &[u8]) -> Option<(u32, u32)> {
    match format {
        ImageFormat::Png => {
            // IHDR chunk right after the 8-byte signature: width (4 BE) +
            // height (4 BE).
            if bytes.len() < 24 {
                return None;
            }
            let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
            let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
            if width == 0 || height == 0 {
                return None;
            }
            Some((width, height))
        }
        ImageFormat::Jpeg => {
            // Scan for a Start-Of-Frame marker (SOF0..SOF15 minus
            // DHT/JPG/DAC, which reuse the number range). After the marker
            // + 2-byte segment length: precision (1), height (2 BE),
            // width (2 BE).
            let mut i = 2usize;
            while i < bytes.len() {
                if bytes[i] != 0xff {
                    i += 1;
                    continue;
                }
                // Skip fill bytes (0xFF padding before a marker).
                while i < bytes.len() && bytes[i] == 0xff {
                    i += 1;
                }
                if i >= bytes.len() {
                    return None;
                }
                let marker = bytes[i];
                i += 1;
                if marker == 0xd8 || marker == 0xd9 {
                    continue; // SOI / EOI — no length
                }
                if i + 1 >= bytes.len() {
                    return None;
                }
                let seg_len = u16::from_be_bytes([bytes[i], bytes[i + 1]]) as usize;
                if is_sof_marker(marker) {
                    if i + 7 >= bytes.len() {
                        return None;
                    }
                    let height = u16::from_be_bytes([bytes[i + 3], bytes[i + 4]]);
                    let width = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]);
                    if width == 0 || height == 0 {
                        return None;
                    }
                    return Some((width as u32, height as u32));
                }
                i += seg_len;
            }
            None
        }
        ImageFormat::Gif => {
            // Logical screen width/height at offsets 6-9, little-endian.
            if bytes.len() < 10 {
                return None;
            }
            let width = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
            let height = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
            if width == 0 || height == 0 {
                return None;
            }
            Some((width, height))
        }
        ImageFormat::Bmp => {
            // 'BM' file header → BITMAPINFOHEADER at offset 14; a bare DIB
            // (clipboard CF_DIB) has no file header → header at offset 0.
            // biWidth/biHeight are i32 LE; a negative height is top-down.
            let base = if bytes.len() >= 2 && bytes[..2] == [b'B', b'M'] {
                14
            } else {
                0
            };
            if bytes.len() < base + 12 {
                return None;
            }
            let width = i32::from_le_bytes([
                bytes[base + 4],
                bytes[base + 5],
                bytes[base + 6],
                bytes[base + 7],
            ]);
            let height = i32::from_le_bytes([
                bytes[base + 8],
                bytes[base + 9],
                bytes[base + 10],
                bytes[base + 11],
            ]);
            let width = u32::try_from(width).ok()?;
            let height = height.unsigned_abs();
            if width == 0 || height == 0 {
                return None;
            }
            Some((width, height))
        }
    }
}

fn is_sof_marker(marker: u8) -> bool {
    (0xc0..=0xcf).contains(&marker) && marker != 0xc4 && marker != 0xc8 && marker != 0xcc
}

/// Read the clipboard image, if any (Windows). Returns the temp file path
/// and mime, or `None` when the clipboard holds no image. The temp file
/// keeps its original format (PNG/JPEG/GIF/BMP — no re-encode), unlike
/// the historical GDI+ re-encode path, which is kept as the fallback.
pub fn clipboard_image() -> anyhow::Result<Option<(PathBuf, String)>> {
    #[cfg(windows)]
    {
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$d = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($d -eq $null) { exit 1 }
$path = $null
# File copies (Explorer) win over image data, matching the TS lookup
# order: the copied file is persisted as-is and sniffed by magic bytes
# on the Rust side. Only image extensions are considered.
if ($d.GetDataPresent('FileDrop')) {
    $files = $d.GetData('FileDrop')
    if ($files -ne $null) {
        foreach ($f in $files) {
            $ext = [System.IO.Path]::GetExtension([string]$f).ToLowerInvariant()
            if ($ext -eq '.png' -or $ext -eq '.jpg' -or $ext -eq '.jpeg' -or $ext -eq '.gif' -or $ext -eq '.bmp') {
                $path = Join-Path $env:TEMP ("kimi-paste-" + [guid]::NewGuid().ToString() + $ext)
                [System.IO.File]::Copy($f, $path, $true)
                break
            }
        }
    }
}
# Native image formats by clipboard format name — raw bytes, no re-encode.
if ($path -eq $null) {
    foreach ($fmt in @('PNG', 'JFIF', 'JPG', 'JPEG', 'GIF')) {
        if (-not $d.GetDataPresent($fmt)) { continue }
        $data = $d.GetData($fmt)
        if ($data -eq $null) { continue }
        if ($data -is [System.IO.Stream]) {
            $ms = [System.IO.MemoryStream]::new()
            $data.CopyTo($ms)
            $data = $ms.ToArray()
        }
        $ext = 'png'
        if ($fmt -eq 'GIF') { $ext = 'gif' }
        elseif ($fmt -ne 'PNG') { $ext = 'jpg' }
        $path = Join-Path $env:TEMP ("kimi-paste-" + [guid]::NewGuid().ToString() + "." + $ext)
        [System.IO.File]::WriteAllBytes($path, [byte[]]$data)
        break
    }
}
# Fallback: GDI+ bitmap re-encoded to PNG (the original behaviour).
if ($path -eq $null) {
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    if ($img -eq $null) { exit 1 }
    $path = Join-Path $env:TEMP ("kimi-paste-" + [guid]::NewGuid().ToString() + ".png")
    $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}
Write-Output $path
"#;
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-STA", "-Command", script])
            .output()?;
        if !output.status.success() {
            // No image (or a non-image clipboard) — not an error.
            return Ok(None);
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            return Ok(None);
        }
        let path = PathBuf::from(path);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => {
                let _ = std::fs::remove_file(&path);
                return Ok(None);
            }
        };
        // Magic-byte sniffing is the single source of truth for the format;
        // the file extension from PowerShell is only a hint (e.g. a `.jpeg`
        // file drop). Files that are not PNG/JPEG/GIF/BMP are dropped.
        let Some(format) = detect_image_format(&bytes) else {
            let _ = std::fs::remove_file(&path);
            return Ok(None);
        };
        let path = fix_extension(path, format);
        Ok(Some((path, format.mime().to_string())))
    }
    #[cfg(not(windows))]
    {
        let _ = (); // clipboard image read is Windows-only for now
        Ok(None)
    }
}

/// Ensure the temp file carries the extension matching the sniffed format
/// (the PowerShell side names the file from the clipboard format name,
/// which may disagree with the magic bytes — e.g. a `.jpeg` file drop).
fn fix_extension(path: PathBuf, format: ImageFormat) -> PathBuf {
    let matches = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(format.extension()));
    if matches {
        return path;
    }
    let mut fixed = path.clone();
    fixed.set_extension(format.extension());
    if std::fs::rename(&path, &fixed).is_ok() {
        fixed
    } else {
        path
    }
}

/// The `[image #N]` placeholder inserted into the input line.
pub fn placeholder(id: usize) -> String {
    format!("[image #{id}]")
}

/// Placeholder carrying the image dimensions — `[image #N (W×H)]`, TS
/// `formatPlaceholder` parity (U+00D7 multiplication sign).
pub fn placeholder_with_size(id: usize, width: u32, height: u32) -> String {
    format!("[image #{id} ({width}×{height})]")
}

/// `[image #N (W×H)]` when the pasted file's dimensions are readable,
/// else the plain `[image #N]` (TS `formatPlaceholder` parity — a failed
/// header parse must not block the paste).
pub fn placeholder_for_path(path: &std::path::Path, id: usize) -> String {
    match std::fs::read(path).ok().and_then(|bytes| {
        let format = detect_image_format(&bytes)?;
        image_dimensions(format, &bytes)
    }) {
        Some((width, height)) => placeholder_with_size(id, width, height),
        None => placeholder(id),
    }
}

/// Expand `[image #N]` placeholders in `text` into prompt content parts:
/// surrounding text as text parts, images as data-URI `image_url` parts
/// (TS `extractMediaAttachments` parity, simplified). Size-suffixed
/// placeholders (`[image #1 (800×600)]`) are accepted too, so a caller
/// that switches to [`placeholder_with_size`] needs no expansion changes.
pub fn expand_placeholders(text: &str, attachments: &[ImageAttachment]) -> serde_json::Value {
    use base64::Engine;
    let re =
        regex::Regex::new(r"\[image #(\d+)(?: \([^]]*\))?\]").expect("valid placeholder regex");
    let mut parts: Vec<serde_json::Value> = Vec::new();
    let mut last = 0usize;
    for cap in re.captures_iter(text) {
        let m = cap.get(0).expect("match");
        let before = &text[last..m.start()];
        if !before.trim().is_empty() {
            parts.push(serde_json::json!({ "type": "text", "text": before }));
        }
        if let Ok(id) = cap[1].parse::<usize>() {
            if let Some(att) = attachments.iter().find(|a| a.id == id) {
                if let Ok(bytes) = std::fs::read(&att.path) {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    parts.push(serde_json::json!({
                        "type": "image_url",
                        "imageUrl": { "url": format!("data:{};base64,{}", att.mime, b64) }
                    }));
                }
            }
        }
        last = m.end();
    }
    let after = &text[last..];
    if !after.trim().is_empty() {
        parts.push(serde_json::json!({ "type": "text", "text": after }));
    }
    if parts.is_empty() {
        parts.push(serde_json::json!({ "type": "text", "text": "" }));
    }
    serde_json::json!(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_roundtrips() {
        assert_eq!(placeholder(3), "[image #3]");
    }

    #[test]
    fn placeholder_with_size_matches_ts_format() {
        // TS `formatPlaceholder`: `[image #1 (640×480)]` (U+00D7).
        assert_eq!(placeholder_with_size(1, 640, 480), "[image #1 (640×480)]");
    }

    #[test]
    fn placeholder_for_path_sizes_or_falls_back() {
        // A minimal PNG signature + IHDR (width/height at offset 16/20).
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&[0, 0, 0, 0x0d]); // IHDR length
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        let dir = std::env::temp_dir().join(format!(
            "kimi-tui-placeholder-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let sized = dir.join("a.png");
        std::fs::write(&sized, &png).unwrap();
        let junk = dir.join("b.bin");
        std::fs::write(&junk, b"not an image").unwrap();
        assert_eq!(placeholder_for_path(&sized, 7), "[image #7 (640×480)]");
        assert_eq!(placeholder_for_path(&junk, 7), "[image #7]");
        assert_eq!(placeholder_for_path(&dir.join("missing.png"), 7), "[image #7]");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn detects_image_formats_from_magic_bytes() {
        assert_eq!(
            detect_image_format(b"\x89PNG\r\n\x1a\nrest"),
            Some(ImageFormat::Png)
        );
        assert_eq!(
            detect_image_format(b"\xff\xd8\xff\xe0rest"),
            Some(ImageFormat::Jpeg)
        );
        assert_eq!(detect_image_format(b"GIF89a rest"), Some(ImageFormat::Gif));
        assert_eq!(detect_image_format(b"GIF87a"), Some(ImageFormat::Gif));
        assert_eq!(detect_image_format(b"BM rest"), Some(ImageFormat::Bmp));
        assert_eq!(detect_image_format(b"not an image"), None);
        assert_eq!(detect_image_format(b""), None);
        assert_eq!(detect_image_format(b"\xff\xd8"), None); // truncated
        assert_eq!(detect_image_format(b"GIF"), None); // truncated
        assert_eq!(ImageFormat::Png.mime(), "image/png");
        assert_eq!(ImageFormat::Jpeg.mime(), "image/jpeg");
        assert_eq!(ImageFormat::Gif.mime(), "image/gif");
        assert_eq!(ImageFormat::Bmp.mime(), "image/bmp");
        assert_eq!(ImageFormat::Jpeg.extension(), "jpg");
    }

    #[test]
    fn png_dimensions_from_ihdr() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&13u32.to_be_bytes()); // IHDR length
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&800u32.to_be_bytes()); // width
        png.extend_from_slice(&600u32.to_be_bytes()); // height
        assert_eq!(image_dimensions(ImageFormat::Png, &png), Some((800, 600)));
    }

    #[test]
    fn jpeg_dimensions_from_sof0() {
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xc0]; // SOI + SOF0
        jpeg.extend_from_slice(&17u16.to_be_bytes()); // segment length
        jpeg.push(8); // precision
        jpeg.extend_from_slice(&120u16.to_be_bytes()); // height
        jpeg.extend_from_slice(&300u16.to_be_bytes()); // width
        jpeg.push(3); // components
        jpeg.extend_from_slice(&[0u8; 6]); // 3 components × 2 bytes
        assert_eq!(image_dimensions(ImageFormat::Jpeg, &jpeg), Some((300, 120)));
    }

    #[test]
    fn jpeg_skips_non_sof_segments() {
        let mut jpeg = vec![0xff, 0xd8];
        // APP0 segment: FF E0, length 16, 14 payload bytes.
        jpeg.extend_from_slice(&[0xff, 0xe0, 0x00, 0x10]);
        jpeg.extend_from_slice(&[0u8; 14]);
        // SOF1 after it: FF C1, length 17, precision 8, height 120, width 300.
        jpeg.extend_from_slice(&[0xff, 0xc1, 0x00, 0x11, 8]);
        jpeg.extend_from_slice(&120u16.to_be_bytes());
        jpeg.extend_from_slice(&300u16.to_be_bytes());
        jpeg.push(3);
        jpeg.extend_from_slice(&[0u8; 6]);
        assert_eq!(image_dimensions(ImageFormat::Jpeg, &jpeg), Some((300, 120)));
    }

    #[test]
    fn gif_dimensions_from_logical_screen_descriptor() {
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&320u16.to_le_bytes()); // width
        gif.extend_from_slice(&240u16.to_le_bytes()); // height
        assert_eq!(image_dimensions(ImageFormat::Gif, &gif), Some((320, 240)));
    }

    #[test]
    fn bmp_dimensions_with_file_header() {
        let mut bmp = b"BM".to_vec();
        bmp.extend_from_slice(&54u32.to_be_bytes()); // file size
        bmp.extend_from_slice(&[0u8; 4]); // reserved
        bmp.extend_from_slice(&54u32.to_be_bytes()); // pixel offset
        bmp.extend_from_slice(&40u32.to_be_bytes()); // BITMAPINFOHEADER size
        bmp.extend_from_slice(&800i32.to_le_bytes()); // width
        bmp.extend_from_slice(&600i32.to_le_bytes()); // height
        assert_eq!(image_dimensions(ImageFormat::Bmp, &bmp), Some((800, 600)));
    }

    #[test]
    fn bmp_dimensions_from_bare_dib() {
        // Clipboard CF_DIB carries no BITMAPFILEHEADER.
        let mut dib = Vec::new();
        dib.extend_from_slice(&40u32.to_be_bytes()); // BITMAPINFOHEADER size
        dib.extend_from_slice(&800i32.to_le_bytes()); // width
        dib.extend_from_slice(&600i32.to_le_bytes()); // height
        assert_eq!(image_dimensions(ImageFormat::Bmp, &dib), Some((800, 600)));
    }

    #[test]
    fn bmp_top_down_height_is_absolutized() {
        let mut dib = Vec::new();
        dib.extend_from_slice(&40u32.to_be_bytes());
        dib.extend_from_slice(&640i32.to_le_bytes());
        dib.extend_from_slice(&(-480i32).to_le_bytes()); // negative = top-down
        assert_eq!(image_dimensions(ImageFormat::Bmp, &dib), Some((640, 480)));
    }

    #[test]
    fn truncated_headers_yield_no_dimensions() {
        assert_eq!(image_dimensions(ImageFormat::Png, b"\x89PNG"), None);
        assert_eq!(
            image_dimensions(ImageFormat::Jpeg, &[0xff, 0xd8, 0xff]),
            None
        );
        assert_eq!(image_dimensions(ImageFormat::Gif, b"GIF89a"), None);
        assert_eq!(image_dimensions(ImageFormat::Bmp, b"BM"), None);
        // Zero-sized headers are rejected too.
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&[0u8; 16]);
        assert_eq!(image_dimensions(ImageFormat::Png, &png), None);
    }

    #[test]
    fn expands_placeholders_to_parts() {
        // A tiny PNG so the data URI is non-trivial.
        let dir = std::env::temp_dir().join(format!("kimi-t-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\npayload").unwrap();
        let attachments = vec![ImageAttachment {
            id: 0,
            path: path.clone(),
            mime: "image/png".into(),
        }];

        let parts = expand_placeholders("look: [image #0] done", &attachments);
        let arr = parts.as_array().expect("array");
        assert_eq!(arr.len(), 3, "text + image + text: {parts}");
        assert_eq!(arr[0]["type"], "text");
        assert_eq!(arr[0]["text"], "look: ");
        assert_eq!(arr[1]["type"], "image_url");
        let url = arr[1]["imageUrl"]["url"].as_str().expect("url");
        assert!(url.starts_with("data:image/png;base64,"), "url: {url}");
        assert!(!url.contains("\u{0}"), "no NUL in url");
        assert_eq!(arr[2]["text"], " done");

        // Unknown attachment id: placeholder is dropped, text survives.
        let parts = expand_placeholders("[image #99] x", &attachments);
        let arr = parts.as_array().expect("array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["text"], " x");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn expand_accepts_size_suffixed_placeholders() {
        let dir = std::env::temp_dir().join(format!("kimi-t-test-{}-size", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\npayload").unwrap();
        let attachments = vec![ImageAttachment {
            id: 0,
            path: path.clone(),
            mime: "image/png".into(),
        }];

        let parts = expand_placeholders("a [image #0 (800×600)] b", &attachments);
        let arr = parts.as_array().expect("array");
        assert_eq!(arr.len(), 3, "{parts}");
        assert_eq!(arr[0]["text"], "a ");
        assert_eq!(arr[1]["type"], "image_url");
        assert_eq!(arr[2]["text"], " b");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_input_yields_single_empty_text_part() {
        let parts = expand_placeholders("", &[]);
        assert_eq!(parts.as_array().unwrap().len(), 1);
        assert_eq!(parts[0]["type"], "text");
    }
}
