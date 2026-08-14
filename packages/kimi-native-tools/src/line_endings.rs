use std::fmt;

/// Line ending style detected in a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEndingStyle {
    Lf,
    CrLf,
    Mixed,
}

impl fmt::Display for LineEndingStyle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Lf => write!(f, "lf"),
            Self::CrLf => write!(f, "crlf"),
            Self::Mixed => write!(f, "mixed"),
        }
    }
}

/// Flags accumulated while scanning for line endings.
#[derive(Debug, Default, Clone)]
pub struct LineEndingFlags {
    pub has_crlf: bool,
    pub has_lf: bool,
    pub has_lone_cr: bool,
    /// True if we saw a bare LF (not part of a CRLF sequence).
    pub has_bare_lf: bool,
}

impl LineEndingFlags {
    /// Feed a single byte into the flags. Callers should feed bytes in order.
    pub fn feed(&mut self, byte: u8) {
        match byte {
            b'\n' => {
                self.has_lf = true;
                self.has_bare_lf = true;
            }
            b'\r' => {
                // Peek is caller's responsibility; we mark lone CR by default
                // and the caller corrects if the next byte is LF.
                self.has_lone_cr = true;
            }
            _ => {}
        }
    }

    /// Feed a CRLF sequence (the caller detected CR followed by LF).
    ///
    /// Callers never feed the CR of the pair through `feed()`, so this must
    /// NOT touch `has_lone_cr` — resetting it here would erase genuine lone
    /// CRs seen earlier in the file and misdetect mixed content as pure CRLF.
    pub fn feed_crlf(&mut self) {
        self.has_crlf = true;
        self.has_lf = true;
    }

    pub fn style(&self) -> LineEndingStyle {
        if self.has_lone_cr {
            // Lone CRs always mean mixed.
            return LineEndingStyle::Mixed;
        }
        if self.has_crlf && self.has_bare_lf {
            // Both CRLF and standalone LF → mixed.
            return LineEndingStyle::Mixed;
        }
        if self.has_crlf {
            return LineEndingStyle::CrLf;
        }
        LineEndingStyle::Lf
    }
}

/// Detect line ending style from raw bytes.
pub fn detect_line_ending_style(data: &[u8]) -> LineEndingStyle {
    let mut flags = LineEndingFlags::default();
    let mut i = 0;
    while i < data.len() {
        if data[i] == b'\r' && i + 1 < data.len() && data[i + 1] == b'\n' {
            flags.feed_crlf();
            i += 2;
        } else {
            flags.feed(data[i]);
            i += 1;
        }
    }
    flags.style()
}

/// Model text view: the model always sees LF-only content.
pub struct ModelTextView {
    pub text: String,
    pub line_ending_style: LineEndingStyle,
}

/// Convert raw disk content to model text view.
/// For pure CRLF files: replaces all \r\n with \n.
/// For LF or mixed: passes through unchanged.
pub fn to_model_text_view(raw: &str) -> ModelTextView {
    let style = detect_line_ending_style(raw.as_bytes());
    let text = match style {
        LineEndingStyle::CrLf => raw.replace("\r\n", "\n"),
        _ => raw.to_string(),
    };
    ModelTextView {
        text,
        line_ending_style: style,
    }
}

/// Convert model text back to disk format.
/// For CRLF style: normalizes any \r\n to \n, then converts all \n to \r\n.
/// For LF or mixed: returns unchanged.
pub fn materialize_model_text(text: &str, style: LineEndingStyle) -> String {
    match style {
        LineEndingStyle::CrLf => {
            // First normalize any existing CRLF to LF, then convert all LF to CRLF.
            let normalized = text.replace("\r\n", "\n");
            normalized.replace("\n", "\r\n")
        }
        _ => text.to_string(),
    }
}

/// Make carriage returns visible for display in mixed-line-ending files.
pub fn make_carriage_returns_visible(text: &str) -> String {
    text.replace('\r', "\\r")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_lf() {
        assert_eq!(
            detect_line_ending_style(b"hello\nworld\n"),
            LineEndingStyle::Lf
        );
    }

    #[test]
    fn test_detect_crlf() {
        assert_eq!(
            detect_line_ending_style(b"hello\r\nworld\r\n"),
            LineEndingStyle::CrLf
        );
    }

    #[test]
    fn test_detect_mixed() {
        assert_eq!(
            detect_line_ending_style(b"hello\r\nworld\n"),
            LineEndingStyle::Mixed
        );
    }

    #[test]
    fn test_detect_lone_cr() {
        assert_eq!(
            detect_line_ending_style(b"hello\rworld"),
            LineEndingStyle::Mixed
        );
    }

    #[test]
    fn test_detect_lone_cr_then_crlf_is_mixed() {
        // A lone CR seen before a CRLF must survive — feed_crlf must not
        // erase it (regression: this used to detect as CrLf).
        assert_eq!(
            detect_line_ending_style(b"a\rb\r\n"),
            LineEndingStyle::Mixed
        );
    }

    #[test]
    fn test_detect_crlf_then_lone_cr_is_mixed() {
        assert_eq!(
            detect_line_ending_style(b"a\r\nb\rc\n"),
            LineEndingStyle::Mixed
        );
    }

    #[test]
    fn test_feed_crlf_preserves_earlier_lone_cr() {
        let mut flags = LineEndingFlags::default();
        flags.feed(b'a');
        flags.feed(b'\r');
        flags.feed(b'b');
        flags.feed_crlf();
        assert_eq!(flags.style(), LineEndingStyle::Mixed);
    }

    #[test]
    fn test_model_view_crlf() {
        let view = to_model_text_view("hello\r\nworld\r\n");
        assert_eq!(view.text, "hello\nworld\n");
        assert_eq!(view.line_ending_style, LineEndingStyle::CrLf);
    }

    #[test]
    fn test_model_view_lf() {
        let view = to_model_text_view("hello\nworld\n");
        assert_eq!(view.text, "hello\nworld\n");
        assert_eq!(view.line_ending_style, LineEndingStyle::Lf);
    }

    #[test]
    fn test_materialize_crlf() {
        let result = materialize_model_text("hello\nworld\n", LineEndingStyle::CrLf);
        assert_eq!(result, "hello\r\nworld\r\n");
    }

    #[test]
    fn test_materialize_lf() {
        let result = materialize_model_text("hello\nworld\n", LineEndingStyle::Lf);
        assert_eq!(result, "hello\nworld\n");
    }
}
