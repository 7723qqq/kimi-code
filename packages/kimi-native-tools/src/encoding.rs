//! Text-encoding detection and transcoding — Rust port of the TS
//! `_base/text/encoding.ts`. BOM sniffing plus the zero-byte parity heuristic
//! recognizes BOM-less UTF-16 LE/BE; the legacy heuristic recognizes
//! GBK/GB18030 and near-UTF-8 content after strict decoding fails. Decoders
//! come from `encoding_rs` (the WHATWG Encoding Standard implementation, the
//! same semantics as Node's `TextDecoder`).
//!
//! Mirrors `packages/agent-core-v2/src/_base/text/encoding.ts` — keep the
//! two in sync.

use encoding_rs::{GBK, UTF_16BE, UTF_16LE};

/// Number of leading bytes inspected for the zero-byte heuristic.
pub const ENCODING_DETECTION_SAMPLE_BYTES: usize = 512;

/// Largest payload transcoded whole from UTF-16 / a legacy encoding.
/// Mirrors `TRANSCODE_MAX_BYTES` in the TS contract.
pub const TRANSCODE_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Minimum zero bytes (at a single parity) before the BOM-less UTF-16
/// heuristic commits.
const MIN_ZERO_BYTES_FOR_UTF16: usize = 2;

/// Min share of bytes replaced by U+FFFD in a lenient UTF-8 decode before the
/// GBK hypothesis is trusted.
const MIN_GBK_UTF8_REPLACEMENT_RATIO: f64 = 0.15;

/// Max share of the file's bytes that may be replaced by U+FFFD in the
/// lenient UTF-8 fallback before the file is refused. Must stay above
/// `MIN_GBK_UTF8_REPLACEMENT_RATIO`.
const MAX_LENIENT_REPLACEMENT_RATIO: f64 = 0.25;

/// UTF encodings detectable from leading bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UtfTextEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

impl UtfTextEncoding {
    /// Human label matching the TS `encodingDisplayName`.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Utf8 => "UTF-8",
            Self::Utf16Le => "UTF-16 LE",
            Self::Utf16Be => "UTF-16 BE",
        }
    }
}

/// Result of sniffing a file's leading bytes.
#[derive(Debug, Clone, Copy)]
pub struct TextEncodingDetection {
    pub encoding: UtfTextEncoding,
    /// Zero bytes present but fitting neither UTF-16 pattern — treat as
    /// binary, not text.
    pub seems_binary: bool,
}

/// Detect the encoding of a text file from its leading bytes (BOM first,
/// then the zero-byte parity heuristic).
pub fn detect_text_encoding(sample: &[u8]) -> TextEncodingDetection {
    // Always trust a BOM first.
    if sample.len() >= 2 {
        let (b0, b1) = (sample[0], sample[1]);
        if b0 == 0xfe && b1 == 0xff {
            return TextEncodingDetection {
                encoding: UtfTextEncoding::Utf16Be,
                seems_binary: false,
            };
        }
        if b0 == 0xff && b1 == 0xfe {
            return TextEncodingDetection {
                encoding: UtfTextEncoding::Utf16Le,
                seems_binary: false,
            };
        }
    }

    // BOM-less UTF-16: zero bytes cluster at one parity — odd indices for LE
    // (`0xAA 0x00`), even for BE (`0x00 0xAA`). Zeros at both parities, or
    // fewer than the ambiguity threshold, mean binary.
    let mut zeros_at_odd = 0usize;
    let mut zeros_at_even = 0usize;
    let limit = sample.len().min(ENCODING_DETECTION_SAMPLE_BYTES);
    for (i, &b) in sample.iter().take(limit).enumerate() {
        if b != 0 {
            continue;
        }
        if i % 2 == 1 {
            zeros_at_odd += 1;
        } else {
            zeros_at_even += 1;
        }
    }

    if zeros_at_odd == 0 && zeros_at_even == 0 {
        return TextEncodingDetection {
            encoding: UtfTextEncoding::Utf8,
            seems_binary: false,
        };
    }
    if zeros_at_even == 0 && zeros_at_odd >= MIN_ZERO_BYTES_FOR_UTF16 {
        return TextEncodingDetection {
            encoding: UtfTextEncoding::Utf16Le,
            seems_binary: false,
        };
    }
    if zeros_at_odd == 0 && zeros_at_even >= MIN_ZERO_BYTES_FOR_UTF16 {
        return TextEncodingDetection {
            encoding: UtfTextEncoding::Utf16Be,
            seems_binary: false,
        };
    }
    TextEncodingDetection {
        encoding: UtfTextEncoding::Utf8,
        seems_binary: true,
    }
}

/// Decode bytes in a detected UTF encoding, replacing malformed sequences and
/// stripping a leading BOM (mirrors `TextDecoder` with `ignoreBOM: false`).
pub fn decode_utf_text(bytes: &[u8], encoding: UtfTextEncoding) -> String {
    let (encoding, offset) = match encoding {
        UtfTextEncoding::Utf16Le => {
            let skip = if bytes.starts_with(&[0xff, 0xfe]) {
                2
            } else {
                0
            };
            (&UTF_16LE, skip)
        }
        UtfTextEncoding::Utf16Be => {
            let skip = if bytes.starts_with(&[0xfe, 0xff]) {
                2
            } else {
                0
            };
            (&UTF_16BE, skip)
        }
        UtfTextEncoding::Utf8 => {
            let skip = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
                3
            } else {
                0
            };
            // UTF-8 never reaches this helper in practice (the streaming
            // reader handles it); decode leniently for completeness.
            if skip == 0 && std::str::from_utf8(bytes).is_ok() {
                return String::from_utf8_lossy(bytes).into_owned();
            }
            return String::from_utf8_lossy(&bytes[skip..]).into_owned();
        }
    };
    let (text, _, _) = encoding.decode(&bytes[offset..]);
    text.into_owned()
}

/// Fallback encodings recognized after strict UTF-8 decoding fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyTextEncoding {
    /// GBK / GB18030 (whole-file transcode; the common case for legacy
    /// Chinese text).
    Gbk,
    /// Almost-UTF-8 payload shown leniently with U+FFFD replacements.
    Utf8Lenient,
}

/// True when the string contains at least one CJK unified ideograph
/// (extension A, the main block, or the compatibility ideographs).
fn contains_cjk_ideograph(text: &str) -> bool {
    text.chars().any(|ch| {
        matches!(ch,
            '\u{3400}'..='\u{4DBF}'
                | '\u{4E00}'..='\u{9FFF}'
                | '\u{F900}'..='\u{FAFF}')
    })
}

/// Decode bytes as UTF-8 without failing, counting the replacement
/// characters introduced by malformed sequences.
pub fn decode_utf8_lenient(bytes: &[u8]) -> (String, usize) {
    let text = String::from_utf8_lossy(bytes);
    let replaced = text.chars().filter(|&ch| ch == '\u{FFFD}').count();
    (text.into_owned(), replaced)
}

/// Detect a legacy 8-bit encoding from bytes that already failed strict
/// UTF-8 decoding — mirrors `detectLegacyTextEncoding`. A confident GBK match
/// requires a replacement-free GBK decode, at least one CJK ideograph, and a
/// non-trivial lenient-UTF-8 replacement ratio (keeps UTF-8 payloads with a
/// small malformed tail out); otherwise a low replacement ratio accepts the
/// lenient-UTF-8 reading; otherwise `None` (refuse).
pub fn detect_legacy_text_encoding(bytes: &[u8]) -> Option<LegacyTextEncoding> {
    if bytes.is_empty() {
        return None;
    }
    let (gbk, _, _) = GBK.decode(bytes);
    if !gbk.contains('\u{FFFD}') && contains_cjk_ideograph(&gbk) {
        let (_, replaced) = decode_utf8_lenient(bytes);
        if replaced as f64 / bytes.len() as f64 >= MIN_GBK_UTF8_REPLACEMENT_RATIO {
            return Some(LegacyTextEncoding::Gbk);
        }
    }
    let (_, replaced) = decode_utf8_lenient(bytes);
    if replaced as f64 / bytes.len() as f64 <= MAX_LENIENT_REPLACEMENT_RATIO {
        return Some(LegacyTextEncoding::Utf8Lenient);
    }
    None
}

/// Decode GBK/GB18030 bytes to UTF-8 with replacement.
pub fn decode_gbk(bytes: &[u8]) -> String {
    let (text, _, _) = GBK.decode(bytes);
    text.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bom_utf16le() {
        let d = detect_text_encoding(&[0xff, 0xfe, b'a', 0x00]);
        assert_eq!(d.encoding, UtfTextEncoding::Utf16Le);
        assert!(!d.seems_binary);
    }

    #[test]
    fn test_bom_utf16be() {
        let d = detect_text_encoding(&[0xfe, 0xff, 0x00, b'a']);
        assert_eq!(d.encoding, UtfTextEncoding::Utf16Be);
        assert!(!d.seems_binary);
    }

    #[test]
    fn test_bomless_utf16le_parity() {
        // ASCII 'a','b' as UTF-16 LE: 61 00 62 00 — zeros at odd indices.
        let d = detect_text_encoding(&[0x61, 0x00, 0x62, 0x00, 0x63, 0x00]);
        assert_eq!(d.encoding, UtfTextEncoding::Utf16Le);
        assert!(!d.seems_binary);
    }

    #[test]
    fn test_bomless_utf16be_parity() {
        let d = detect_text_encoding(&[0x00, 0x61, 0x00, 0x62, 0x00, 0x63]);
        assert_eq!(d.encoding, UtfTextEncoding::Utf16Be);
        assert!(!d.seems_binary);
    }

    #[test]
    fn test_isolated_zero_is_binary() {
        let d = detect_text_encoding(b"plain prefix\x00\x01");
        assert!(d.seems_binary);
        assert_eq!(d.encoding, UtfTextEncoding::Utf8);
    }

    #[test]
    fn test_zeros_at_both_parities_is_binary() {
        let d = detect_text_encoding(&[0x00, 0x00, 0x61, 0x00, 0x00, 0x62]);
        assert!(d.seems_binary);
    }

    #[test]
    fn test_plain_ascii_is_utf8() {
        let d = detect_text_encoding(b"hello world");
        assert_eq!(d.encoding, UtfTextEncoding::Utf8);
        assert!(!d.seems_binary);
    }

    #[test]
    fn test_decode_utf16le_strips_bom_and_handles_cjk() {
        // BOM + '中' (U+4E2D) + '\n' in UTF-16 LE.
        let bytes = [0xff, 0xfe, 0x2d, 0x4e, 0x0a, 0x00];
        let text = decode_utf_text(&bytes, UtfTextEncoding::Utf16Le);
        assert_eq!(text, "中\n");
    }

    #[test]
    fn test_decode_utf16be_strips_bom() {
        let bytes = [0xfe, 0xff, 0x4e, 0x2d, 0x00, 0x0a];
        let text = decode_utf_text(&bytes, UtfTextEncoding::Utf16Be);
        assert_eq!(text, "中\n");
    }

    #[test]
    fn test_detect_gbk() {
        // "中文内容\n" in GBK — valid GBK with CJK, and heavily malformed
        // as UTF-8 (replacement ratio well above 0.15).
        let gbk = [0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd, 0x0a];
        assert_eq!(
            detect_legacy_text_encoding(&gbk),
            Some(LegacyTextEncoding::Gbk)
        );
        assert_eq!(decode_gbk(&gbk), "中文内容\n");
    }

    #[test]
    fn test_almost_utf8_is_lenient() {
        // Valid UTF-8 line plus one junk byte — decodes as GBK without CJK
        // and with a tiny replacement ratio, so the lenient reading wins.
        let mut bytes = b"\xe6\xad\xa3\xe5\xb8\xb8\n".to_vec(); // 正常\n
        bytes.push(0x88);
        assert_eq!(
            detect_legacy_text_encoding(&bytes),
            Some(LegacyTextEncoding::Utf8Lenient)
        );
    }

    #[test]
    fn test_garbage_is_refused() {
        let bytes = [0xff; 8];
        assert_eq!(detect_legacy_text_encoding(&bytes), None);
    }

    #[test]
    fn test_empty_is_refused() {
        assert_eq!(detect_legacy_text_encoding(&[]), None);
    }

    #[test]
    fn test_ascii_never_gbk_nor_lenient_path() {
        // Pure ASCII decodes as GBK with no CJK → falls to the lenient
        // branch with zero replacements (accepted; never reached in practice
        // because pure ASCII never fails strict UTF-8).
        assert_eq!(
            detect_legacy_text_encoding(b"hello"),
            Some(LegacyTextEncoding::Utf8Lenient)
        );
    }
}
