/// File type detection via magic bytes and extension sniffing.
/// Mirrors the TypeScript `detectFileType` in `support/file-type.ts`.
use std::path::Path;

/// Number of bytes to read from file header for magic-byte detection.
pub const MEDIA_SNIFF_BYTES: usize = 512;

/// Detected file kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Text,
    Image,
    Video,
    Unknown,
}

/// Detect file type from path extension and header bytes.
pub fn detect_file_type(path: &Path, header: &[u8]) -> FileKind {
    // Check extension first for known media types.
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext_lower = ext.to_ascii_lowercase();
        match ext_lower.as_str() {
            // Image extensions
            | "png" | "jpg" | "jpeg" | "gif" | "bmp" | "ico" | "webp" | "svg"
            | "tiff" | "tif" | "avif" | "heic" | "heif" | "raw" | "cr2" | "nef"
            | "arw" | "dng" | "psd" | "ai" => return FileKind::Image,
            // Video extensions
            | "mp4" | "webm" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "m4v"
            | "mpg" | "mpeg" | "3gp" | "ogv" => return FileKind::Video,
            _ => {}
        }
    }

    // Magic byte detection for images.
    if is_image_magic(header) {
        return FileKind::Image;
    }

    // Magic byte detection for videos.
    if is_video_magic(header) {
        return FileKind::Video;
    }

    // Check for NUL bytes — strong indicator of binary content.
    if header.contains(&0) {
        return FileKind::Unknown;
    }

    // If we got here and the header is valid UTF-8 (or ASCII), it's text.
    if std::str::from_utf8(header).is_ok() {
        FileKind::Text
    } else {
        FileKind::Unknown
    }
}

fn is_image_magic(header: &[u8]) -> bool {
    if header.len() < 4 {
        return false;
    }
    // PNG: 89 50 4E 47
    if header.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return true;
    }
    // JPEG: FF D8 FF
    if header.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return true;
    }
    // GIF: GIF8
    if header.starts_with(b"GIF8") {
        return true;
    }
    // BMP: BM
    if header.starts_with(b"BM") {
        return true;
    }
    // ICO: 00 00 01 00
    if header.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return true;
    }
    // WebP: RIFF....WEBP
    if header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"WEBP" {
        return true;
    }
    // TIFF: II or MM
    if header.starts_with(b"II") || header.starts_with(b"MM") {
        return true;
    }
    false
}

fn is_video_magic(header: &[u8]) -> bool {
    if header.len() < 8 {
        return false;
    }
    // ftyp box (MP4, MOV, M4V, 3GP): starts with ....ftyp
    if header.len() >= 8 && &header[4..8] == b"ftyp" {
        return true;
    }
    // WebM/MKV: EBML header (1A 45 DF A3)
    if header.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return true;
    }
    // AVI: RIFF....AVI
    if header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"AVI " {
        return true;
    }
    // FLV: FLV\x01
    if header.starts_with(b"FLV\x01") {
        return true;
    }
    // OGG: OggS
    if header.starts_with(b"OggS") {
        return true;
    }
    false
}

/// Returns true if the content appears to be readable UTF-8 text.
#[allow(dead_code)]
pub fn is_readable_text(data: &[u8]) -> bool {
    if data.contains(&0) {
        return false;
    }
    std::str::from_utf8(data).is_ok()
}

/// Sensitive-file basenames that grep / read should refuse to surface.
///
/// Mirrors `packages/agent-core/src/tools/policies/sensitive.ts` —
/// keep the two lists in sync. The list is intentionally short to
/// avoid false positives; exemptions like `.env.example` are handled
/// explicitly in `is_sensitive_file`.
const SENSITIVE_BASENAMES: &[&str] = &[".env", "id_rsa", "id_ed25519", "id_ecdsa", "credentials"];

const ENV_EXEMPTIONS: &[&str] = &[".env.example", ".env.sample", ".env.template"];
const PUBLIC_KEY_BASENAMES: &[&str] = &["id_rsa.pub", "id_ed25519.pub", "id_ecdsa.pub"];

const SENSITIVE_BASENAME_PREFIXES: &[&str] = &["id_rsa", "id_ed25519", "id_ecdsa", "credentials"];

const SENSITIVE_DOT_VARIANT_SUFFIXES: &[&str] = &[
    ".bak", ".backup", ".copy", ".disabled", ".key", ".old", ".orig", ".pem", ".save", ".tmp",
];

/// Returns true when the supplied path points at a credentials-bearing
/// file. Matching is case-insensitive and pattern-aware: `.env.local` is
/// flagged but `.env.example` is exempted, and `id_rsa.bak` is flagged
/// while `id_rsafoo` is not.
pub fn is_sensitive_file(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let basename = normalized.rsplit('/').next().unwrap_or(path);
    let comparable_name = basename.to_lowercase();
    let comparable_path = normalized.to_lowercase();

    if ENV_EXEMPTIONS.iter().any(|e| *e == comparable_name) {
        return false;
    }
    if PUBLIC_KEY_BASENAMES.iter().any(|e| *e == comparable_name) {
        return false;
    }
    if SENSITIVE_BASENAMES.iter().any(|e| *e == comparable_name) {
        return true;
    }
    if comparable_name.starts_with(".env.") {
        return true;
    }

    for prefix in SENSITIVE_BASENAME_PREFIXES {
        if comparable_name == *prefix {
            return true;
        }
        if comparable_name.len() > prefix.len() && comparable_name.starts_with(prefix) {
            let suffix = &comparable_name[prefix.len()..];
            let next = suffix.chars().next();
            if next == Some('-') || next == Some('_') {
                return true;
            }
            if next == Some('.') && SENSITIVE_DOT_VARIANT_SUFFIXES.iter().any(|s| *s == suffix) {
                return true;
            }
        }
    }

    for suffix in [".aws/credentials", ".gcp/credentials"] {
        if comparable_path.ends_with(&format!("/{}", suffix))
            || comparable_path.contains(&format!("/{}/", suffix))
        {
            return true;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_png_magic() {
        let header = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(detect_file_type(&PathBuf::from("test"), header), FileKind::Image);
    }

    #[test]
    fn test_jpeg_magic() {
        let header = &[0xFF, 0xD8, 0xFF, 0xE0];
        assert_eq!(detect_file_type(&PathBuf::from("test"), header), FileKind::Image);
    }

    #[test]
    fn test_gif_magic() {
        assert_eq!(detect_file_type(&PathBuf::from("test"), b"GIF89a"), FileKind::Image);
    }

    #[test]
    fn test_mp4_magic() {
        // ftyp box
        let header = b"\x00\x00\x00\x1cftypisom\x00\x00\x02\x00";
        assert_eq!(detect_file_type(&PathBuf::from("test"), header), FileKind::Video);
    }

    #[test]
    fn test_webm_magic() {
        let header = &[0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x00, 0x00, 0x00];
        assert_eq!(detect_file_type(&PathBuf::from("test"), header), FileKind::Video);
    }

    #[test]
    fn test_text_content() {
        assert_eq!(
            detect_file_type(&PathBuf::from("test.txt"), b"hello world\n"),
            FileKind::Text
        );
    }

    #[test]
    fn test_nul_bytes_unknown() {
        assert_eq!(
            detect_file_type(&PathBuf::from("test.bin"), b"hello\x00world"),
            FileKind::Unknown
        );
    }

    #[test]
    fn test_extension_override() {
        // Even if header looks like text, extension wins for known media.
        assert_eq!(
            detect_file_type(&PathBuf::from("photo.png"), b"not a png"),
            FileKind::Image
        );
    }

    #[test]
    fn test_is_readable_text() {
        assert!(is_readable_text(b"hello world"));
        assert!(!is_readable_text(b"hello\x00world"));
        assert!(!is_readable_text(&[0xFF, 0xFE]));
    }

    #[test]
    fn test_is_sensitive_file_basenames() {
        assert!(is_sensitive_file("/repo/.env"));
        assert!(is_sensitive_file("/repo/.env.local"));
        assert!(is_sensitive_file("/repo/.env.production"));
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa"));
        assert!(is_sensitive_file("/home/user/.ssh/id_ed25519"));
        assert!(is_sensitive_file("/home/user/.aws/credentials"));
        assert!(is_sensitive_file("/some/path/.gcp/credentials"));
        assert!(is_sensitive_file("C:\\Users\\foo\\.aws\\credentials"));
    }

    #[test]
    fn test_is_sensitive_file_exemptions() {
        // Public-key files and template envs are intentionally allowed.
        assert!(!is_sensitive_file("/repo/.env.example"));
        assert!(!is_sensitive_file("/repo/.env.sample"));
        assert!(!is_sensitive_file("/repo/.env.template"));
        assert!(!is_sensitive_file("/home/user/.ssh/id_rsa.pub"));
        assert!(!is_sensitive_file("/home/user/.ssh/id_ed25519.pub"));
    }

    #[test]
    fn test_is_sensitive_file_variants() {
        // Rename-shielded variants must still be caught.
        assert!(is_sensitive_file("/secrets/id_rsa.bak"));
        assert!(is_sensitive_file("/secrets/id_rsa.old"));
        assert!(is_sensitive_file("/secrets/id_rsa-backup"));
        assert!(is_sensitive_file("/secrets/id_rsa_disabled"));
        // Unrelated filenames sharing a prefix are not flagged.
        assert!(!is_sensitive_file("/code/id_rsafoo.txt"));
        assert!(!is_sensitive_file("/code/credentials.json"));
    }

    #[test]
    fn test_is_sensitive_file_case_insensitive() {
        assert!(is_sensitive_file("/repo/.ENV"));
        assert!(is_sensitive_file("/home/User/.SSH/ID_RSA"));
    }
}
