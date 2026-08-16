/// Read tool — reads a text file with line numbers, respecting MAX_LINES,
/// MAX_LINE_LENGTH, and MAX_BYTES limits. Supports forward reading and
/// tail reading (negative line_offset). UTF-16 LE/BE text (BOM or zero-byte
/// parity) and GBK/GB18030 / near-UTF-8 payloads are transcoded natively via
/// the `encoding` module, so the whole capability set lives here — TypeScript
/// is only a fallback for hosts without the native module.
///
/// Mirrors `packages/agent-core-v2/src/agent/tools/os/read/read.ts` and
/// `packages/agent-core-v2/src/agent/tools/os/read/readTool.ts`.
use crate::encoding::{
    decode_gbk, decode_utf8_lenient, decode_utf_text, detect_legacy_text_encoding,
    detect_text_encoding, LegacyTextEncoding, UtfTextEncoding, TRANSCODE_MAX_BYTES,
};
use crate::file_type::{detect_file_type, FileKind, MEDIA_SNIFF_BYTES};
use crate::line_endings::{make_carriage_returns_visible, LineEndingFlags, LineEndingStyle};
use napi_derive::napi;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

/// Maximum lines that can be read or tailed in one call.
pub const MAX_LINES: usize = 1000;
/// Individual lines longer than this are truncated with `...`.
pub const MAX_LINE_LENGTH: usize = 2000;
/// Output stops once rendered output exceeds this byte count (UTF-8).
pub const MAX_BYTES: usize = 100 * 1024;

/// Result of a read operation.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct ReadResult {
    pub content: String,
    pub line_count: i32,
    pub error: Option<String>,
    /// Machine-readable error class — `not_found` / `not_a_file` / `media` /
    /// `binary` / `invalid_utf8` / `too_large` / `io` / `panic`. Every kind is
    /// the native reader's final verdict (the UTF-16 / GBK / lenient fallback
    /// chain runs inside it) and must not be re-run in TypeScript.
    pub error_kind: Option<String>,
}

impl ReadResult {
    /// Build an error result carrying a machine-readable kind.
    fn err(kind: &str, message: String) -> Self {
        Self {
            content: String::new(),
            line_count: 0,
            error: Some(message),
            error_kind: Some(kind.to_string()),
        }
    }
}

/// Configuration for a read operation.
pub struct ReadConfig {
    pub path: String,
    pub line_offset: Option<i64>,
    pub n_lines: Option<u32>,
}

/// Encoding a read's content was transcoded from — surfaced as the trailing
/// note sentence, mirroring the TS `finishMessage` encoding notes verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EncodingNote {
    Utf16(UtfTextEncoding),
    Gbk,
    Utf8Lenient,
}

impl EncodingNote {
    fn message(&self) -> String {
        match self {
            Self::Utf16(enc) => format!(
                "Detected file encoding: {}; content transcoded to UTF-8 for display. Edit and Write expect UTF-8 — convert the file's encoding first (e.g. `iconv` via Bash).",
                enc.display_name()
            ),
            Self::Gbk => "Detected GBK/GB18030 encoding; content transcoded to UTF-8 for display. Edit and Write expect UTF-8 — convert the file's encoding first (e.g. `iconv` via Bash).".to_string(),
            Self::Utf8Lenient => "Some bytes were not valid UTF-8 and were replaced with U+FFFD; content shown best-effort.".to_string(),
        }
    }
}

/// Yields raw lines with terminators (`... \n`), like the TS
/// `splitLinesKeepingTerminator`. Shared by the streaming UTF-8 reader and
/// the in-memory transcoded paths so budgets and rendering stay identical.
trait LineSource {
    /// `Ok(None)` at end of input. `InvalidData` means non-UTF-8 bytes
    /// (streaming source only — transcoded sources are already UTF-8).
    fn next_line(&mut self) -> io::Result<Option<String>>;
}

/// Streaming source over a file, strictly UTF-8. Strips a leading UTF-8 BOM
/// from the first line (mirrors `TextDecoder` with `ignoreBOM: false`).
struct ReaderLines<'a> {
    reader: &'a mut BufReader<File>,
    first: bool,
}

impl LineSource for ReaderLines<'_> {
    fn next_line(&mut self) -> io::Result<Option<String>> {
        let mut line = String::new();
        let n = self.reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        if self.first {
            self.first = false;
            if let Some(stripped) = line.strip_prefix('\u{FEFF}') {
                line = stripped.to_string();
            }
        }
        Ok(Some(line))
    }
}

/// In-memory source over transcoded text, pre-split keeping terminators.
struct OwnedLines {
    lines: std::vec::IntoIter<String>,
}

impl OwnedLines {
    fn new(text: &str) -> Self {
        let mut lines = Vec::new();
        let mut start = 0;
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                lines.push(text[start..=i].to_string());
                start = i + 1;
            }
        }
        if start < text.len() {
            lines.push(text[start..].to_string());
        }
        Self {
            lines: lines.into_iter(),
        }
    }
}

impl LineSource for OwnedLines {
    fn next_line(&mut self) -> io::Result<Option<String>> {
        Ok(self.lines.next())
    }
}

/// Read a text file, returning formatted content with line numbers.
///
/// Behavior:
///   - `line_offset` positive: start from that line (1-indexed)
///   - `line_offset` negative: read from end of file (tail mode)
///   - `n_lines`: number of lines to read (capped at MAX_LINES)
///   - Lines longer than MAX_LINE_LENGTH are truncated
///   - Output stops at MAX_BYTES
///   - UTF-16 LE/BE (BOM or zero-byte parity) is transcoded whole, bounded
///     by TRANSCODE_MAX_BYTES; strict-UTF-8 failures fall back to
///     GBK/GB18030, then lenient UTF-8, before the file is refused
pub fn read_file(config: &ReadConfig) -> ReadResult {
    let path = Path::new(&config.path);

    // Check file exists and is a regular file.
    let file_size = match std::fs::metadata(path) {
        Ok(meta) => {
            if meta.is_dir() {
                return ReadResult::err(
                    "not_a_file",
                    format!("\"{}\" is not a file.", config.path),
                );
            }
            // Check POSIX file type via mode bits (cross-platform).
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = meta.permissions().mode();
                if (mode & 0o170000) != 0o100000 {
                    return ReadResult::err(
                        "not_a_file",
                        format!("\"{}\" is not a file.", config.path),
                    );
                }
            }
            meta.len()
        }
        Err(e) => {
            if e.kind() == io::ErrorKind::NotFound {
                return ReadResult::err(
                    "not_found",
                    format!("\"{}\" does not exist.", config.path),
                );
            }
            return ReadResult::err("io", e.to_string());
        }
    };

    // Sniff file type from header bytes.
    let header = match read_header_bytes(path, MEDIA_SNIFF_BYTES) {
        Ok(h) => h,
        Err(e) => return ReadResult::err("io", e.to_string()),
    };

    // Image / video magic redirects to ReadMediaFile immediately. The
    // NUL-based binary verdict is deliberately deferred: a UTF-16 text file's
    // header is full of NUL bytes, and encoding detection (next) must get
    // its chance first — mirroring the TS ordering.
    let file_kind = detect_file_type(path, &header);
    match file_kind {
        FileKind::Image => {
            return ReadResult::err(
                "media",
                format!(
                    "\"{}\" is an image file. Use ReadMediaFile to read image or video files.",
                    config.path
                ),
            );
        }
        FileKind::Video => {
            return ReadResult::err(
                "media",
                format!(
                    "\"{}\" is a video file. Use ReadMediaFile to read image or video files.",
                    config.path
                ),
            );
        }
        FileKind::Unknown | FileKind::Text => {}
    }

    // UTF-16 LE/BE text (BOM or zero-byte parity heuristic): decode the
    // whole file and transcode to UTF-8 for display.
    let detection = detect_text_encoding(&header);
    if !detection.seems_binary && detection.encoding != UtfTextEncoding::Utf8 {
        if file_size > TRANSCODE_MAX_BYTES {
            return ReadResult::err(
                "too_large",
                format!(
                    "\"{}\" is {} text but too large to transcode ({} bytes > {}). Convert it to UTF-8 first (e.g. `iconv` via Bash).",
                    config.path,
                    detection.encoding.display_name(),
                    file_size,
                    TRANSCODE_MAX_BYTES
                ),
            );
        }
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => return ReadResult::err("io", e.to_string()),
        };
        let text = decode_utf_text(&bytes, detection.encoding);
        return dispatch_transcoded(&text, config, EncodingNote::Utf16(detection.encoding));
    }

    // Not UTF-16: a NUL-bearing header is now a genuine binary verdict.
    if file_kind == FileKind::Unknown {
        return ReadResult::err("binary", not_readable_message(&config.path));
    }

    // Strict UTF-8 streaming. A mid-stream InvalidData error routes into the
    // legacy fallback chain below before the file is refused.
    let result = {
        let file = match File::open(path) {
            Ok(f) => f,
            Err(e) => return ReadResult::err("io", e.to_string()),
        };
        let mut reader = BufReader::new(file);
        let mut source = ReaderLines {
            reader: &mut reader,
            first: true,
        };
        dispatch_scan(&mut source, config, &config.path, None)
    };
    if result.error_kind.as_deref() == Some("invalid_utf8") {
        return legacy_fallback(path, file_size, config);
    }
    result
}

/// Run the forward/tail scan over an already-decoded UTF-8 text.
fn dispatch_transcoded(text: &str, config: &ReadConfig, note: EncodingNote) -> ReadResult {
    let mut source = OwnedLines::new(text);
    dispatch_scan(&mut source, config, &config.path, Some(note))
}

/// Route to forward or tail scanning by `line_offset` sign.
fn dispatch_scan(
    source: &mut dyn LineSource,
    config: &ReadConfig,
    display_path: &str,
    note: Option<EncodingNote>,
) -> ReadResult {
    let line_offset = config.line_offset.unwrap_or(1);
    if line_offset < 0 {
        let tail_count = (-line_offset) as usize;
        let tail_count = tail_count.min(MAX_LINES);
        // Single-pass: scan + tail read in one traversal.
        scan_and_read_tail(source, display_path, tail_count, config.n_lines, note)
    } else {
        let start_line = line_offset as usize;
        let max_lines = config.n_lines.unwrap_or(MAX_LINES as u32) as usize;
        let max_lines = max_lines.min(MAX_LINES);
        // Single-pass: scan + read in one traversal.
        scan_and_read_forward(source, display_path, start_line, max_lines, note)
    }
}

/// Strict UTF-8 failed mid-file: try GBK/GB18030 (the common case for legacy
/// Chinese text), then a lenient UTF-8 decode gated on the replacement
/// ratio, and refuse the file when neither applies.
fn legacy_fallback(path: &Path, file_size: u64, config: &ReadConfig) -> ReadResult {
    if file_size > TRANSCODE_MAX_BYTES {
        return ReadResult::err("invalid_utf8", not_utf8_decodable_message(&config.path));
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return ReadResult::err("io", e.to_string()),
    };
    match detect_legacy_text_encoding(&bytes) {
        Some(LegacyTextEncoding::Gbk) => {
            dispatch_transcoded(&decode_gbk(&bytes), config, EncodingNote::Gbk)
        }
        Some(LegacyTextEncoding::Utf8Lenient) => {
            let (text, _) = decode_utf8_lenient(&bytes);
            dispatch_transcoded(&text, config, EncodingNote::Utf8Lenient)
        }
        None => ReadResult::err("invalid_utf8", not_utf8_decodable_message(&config.path)),
    }
}

/// Single-pass scan + read: walks the line source once, detecting line
/// endings and NUL bytes while simultaneously collecting the requested range.
fn scan_and_read_forward(
    source: &mut dyn LineSource,
    display_path: &str,
    start_line: usize,
    max_lines: usize,
    note: Option<EncodingNote>,
) -> ReadResult {
    let mut line_no = 0usize;
    let mut total_lines = 0usize;
    let mut has_nul = false;
    let mut flags = LineEndingFlags::default();
    let mut rendered = Vec::new();
    let mut total_bytes = 0usize;
    let mut truncated_line_numbers = Vec::new();
    let mut max_lines_reached = false;
    let mut bytes_truncated = false;

    while let Some(line) = match source.next_line() {
        Ok(Some(l)) => Some(l),
        Ok(None) => None,
        Err(e) => {
            // read_line reports non-UTF-8 bytes as InvalidData; anything
            // else is a genuine I/O failure.
            let kind = if e.kind() == io::ErrorKind::InvalidData {
                "invalid_utf8"
            } else {
                "io"
            };
            return ReadResult::err(kind, e.to_string());
        }
    } {
        // Check for NUL bytes.
        if line.as_bytes().contains(&0) {
            has_nul = true;
        }

        // Track line endings: feed the stripped content (mid-line CRs count
        // as lone CRs), then classify the terminator itself. The bare-LF
        // case must be fed too, or LF+CRLF mixed files detect as pure CRLF.
        let stripped_for_scan = line
            .strip_suffix("\r\n")
            .or_else(|| line.strip_suffix('\n'))
            .unwrap_or(&line);
        for ch in stripped_for_scan.bytes() {
            flags.feed(ch);
        }
        if line.ends_with("\r\n") {
            flags.feed_crlf();
        } else if line.ends_with('\n') {
            flags.feed(b'\n');
        }

        total_lines += 1;
        line_no += 1;

        // Skip lines before start_line.
        if line_no < start_line {
            continue;
        }

        // Stop if we've collected enough lines.
        if rendered.len() >= max_lines {
            max_lines_reached = max_lines >= MAX_LINES;
            continue; // keep counting total_lines
        }

        let stripped = strip_trailing_newline(&line);
        let (rendered_line, was_truncated) = render_line(stripped, line_no, flags.style());
        // The first rendered line carries no separator byte (mirrors the TS
        // renderedLineBytes isFirst accounting).
        let line_bytes = rendered_line.len() + usize::from(!rendered.is_empty());
        if total_bytes + line_bytes > MAX_BYTES && !rendered.is_empty() {
            // Byte budget exhausted: stop collecting but keep counting
            // total_lines so the finish note reports the real file size.
            bytes_truncated = true;
            continue;
        }
        if was_truncated {
            truncated_line_numbers.push(line_no);
        }
        total_bytes += line_bytes;
        rendered.push(rendered_line);
    }

    if has_nul {
        return ReadResult::err("binary", not_readable_message(display_path));
    }

    if total_lines == 0 {
        return ReadResult {
            content: "<system>No lines read from file. Total lines in file: 0.</system>"
                .to_string(),
            line_count: 0,
            error: None,
            error_kind: None,
        };
    }

    if start_line > total_lines {
        let message = format!(
            "Line {} exceeds the total number of lines ({}).",
            start_line, total_lines
        );
        return ReadResult {
            content: finish_output(&[], &message),
            line_count: total_lines as i32,
            error: None,
            error_kind: None,
        };
    }

    let message = finish_message(
        rendered.len(),
        start_line,
        total_lines,
        max_lines_reached,
        bytes_truncated || total_bytes >= MAX_BYTES,
        &truncated_line_numbers,
        flags.style(),
        max_lines,
        note,
    );
    let content = finish_output(&rendered, &message);

    ReadResult {
        content,
        line_count: total_lines as i32,
        error: None,
        error_kind: None,
    }
}

/// Single-pass scan + tail read: walks the line source once, keeping the last
/// N lines in a ring buffer while detecting line endings and NUL bytes.
fn scan_and_read_tail(
    source: &mut dyn LineSource,
    display_path: &str,
    tail_count: usize,
    n_lines: Option<u32>,
    note: Option<EncodingNote>,
) -> ReadResult {
    // `line_offset` locates the START of the window (the last `tail_count`
    // lines); `n_lines` then caps how many of those are returned, matching
    // the TS implementation. Without `n_lines`, the whole window is shown.
    let effective_limit = n_lines
        .map(|n| (n as usize).min(MAX_LINES))
        .unwrap_or(tail_count.min(MAX_LINES));
    let keep = tail_count.min(MAX_LINES);

    let mut total_lines = 0usize;
    let mut has_nul = false;
    let mut flags = LineEndingFlags::default();
    let mut ring: VecDeque<(usize, String)> = VecDeque::new();

    while let Some(line) = match source.next_line() {
        Ok(Some(l)) => Some(l),
        Ok(None) => None,
        Err(e) => {
            // read_line reports non-UTF-8 bytes as InvalidData; anything
            // else is a genuine I/O failure.
            let kind = if e.kind() == io::ErrorKind::InvalidData {
                "invalid_utf8"
            } else {
                "io"
            };
            return ReadResult::err(kind, e.to_string());
        }
    } {
        if line.as_bytes().contains(&0) {
            has_nul = true;
        }

        // Track line endings — same content + terminator feeding as the
        // forward scan, so mid-line lone CRs are detected in tail mode too.
        let stripped_for_scan = line
            .strip_suffix("\r\n")
            .or_else(|| line.strip_suffix('\n'))
            .unwrap_or(&line);
        for ch in stripped_for_scan.bytes() {
            flags.feed(ch);
        }
        if line.ends_with("\r\n") {
            flags.feed_crlf();
        } else if line.ends_with('\n') {
            flags.feed(b'\n');
        }

        total_lines += 1;
        let raw = strip_trailing_newline(&line).to_string();
        ring.push_back((total_lines, raw));
        while ring.len() > keep {
            ring.pop_front();
        }
    }

    if has_nul {
        return ReadResult::err("binary", not_readable_message(display_path));
    }

    if total_lines == 0 {
        return ReadResult {
            content: "<system>No lines read from file. Total lines in file: 0.</system>"
                .to_string(),
            line_count: 0,
            error: None,
            error_kind: None,
        };
    }

    let mut entries: Vec<(usize, String)> = ring.into_iter().collect();
    // The ring holds the last `keep` lines (the tail window). `n_lines`
    // caps the returned count from the START of that window, matching the
    // TS implementation (offset locates the window, n_lines the count).
    if entries.len() > effective_limit {
        entries.truncate(effective_limit);
    }

    let line_ending_style = flags.style();
    let mut rendered = Vec::new();
    let mut total_bytes = 0usize;
    let mut truncated_line_numbers = Vec::new();
    let mut bytes_truncated = false;
    for (line_no, raw_line) in entries.iter().rev() {
        let (rendered_line, was_truncated) = render_line(raw_line, *line_no, line_ending_style);
        // First collected line (the file's last) carries no separator byte,
        // mirroring the TS kept-list accounting in finishTailEntries.
        let line_bytes = rendered_line.len() + usize::from(!rendered.is_empty());
        if total_bytes + line_bytes > MAX_BYTES && !rendered.is_empty() {
            bytes_truncated = true;
            break;
        }
        if was_truncated {
            truncated_line_numbers.push(*line_no);
        }
        total_bytes += line_bytes;
        rendered.push(rendered_line);
    }
    rendered.reverse();

    let start_line = entries.first().map(|(line_no, _)| *line_no).unwrap_or(1);
    let requested_lines = n_lines.unwrap_or(MAX_LINES as u32) as usize;
    let message = finish_message(
        rendered.len(),
        start_line,
        total_lines,
        false,
        bytes_truncated || total_bytes >= MAX_BYTES,
        &truncated_line_numbers,
        line_ending_style,
        requested_lines,
        note,
    );
    let content = finish_output(&rendered, &message);

    ReadResult {
        content,
        line_count: total_lines as i32,
        error: None,
        error_kind: None,
    }
}

/// Strip only the trailing `\n` — a trailing `\r` (from a CRLF terminator or
/// a lone-CR final line) is kept for per-style rendering, mirroring the TS
/// `stripTrailingLf`. Stripping `\r\n` wholesale would hide the CR on mixed
/// files and the model could no longer reproduce those lines in Edit.
fn strip_trailing_newline(line: &str) -> &str {
    line.strip_suffix('\n').unwrap_or(line)
}

fn render_line(raw: &str, line_no: usize, style: LineEndingStyle) -> (String, bool) {
    let mut line = raw.to_string();
    let mut was_truncated = false;

    // For pure CRLF files, strip trailing \r.
    if style == LineEndingStyle::CrLf && line.ends_with('\r') {
        line.pop();
    }

    // Truncate to MAX_LINE_LENGTH characters (the TS budget counts code
    // units, not bytes), keeping the total — including the "..." marker —
    // at MAX_LINE_LENGTH. Truncate by chars: byte-indexed truncation would
    // panic when the cut point splits a multi-byte UTF-8 sequence.
    if line.chars().count() > MAX_LINE_LENGTH {
        const MARKER: &str = "...";
        let keep = MAX_LINE_LENGTH - MARKER.len();
        line = line.chars().take(keep).collect();
        line.push_str(MARKER);
        was_truncated = true;
    }

    // For mixed files, make CR visible (after truncation, matching TS).
    if style == LineEndingStyle::Mixed {
        line = make_carriage_returns_visible(&line);
    }

    (format!("{}\t{}", line_no, line), was_truncated)
}

fn finish_output(rendered: &[String], message: &str) -> String {
    if rendered.is_empty() {
        return format!("<system>{}</system>", message);
    }
    let mut result = rendered.join("\n");
    result.push_str("\n<system>");
    result.push_str(message);
    result.push_str("</system>");
    result
}

#[allow(clippy::too_many_arguments)]
fn finish_message(
    rendered_count: usize,
    start_line: usize,
    total_lines: usize,
    max_lines_reached: bool,
    max_bytes_reached: bool,
    truncated_line_numbers: &[usize],
    line_ending_style: LineEndingStyle,
    requested_lines: usize,
    encoding_note: Option<EncodingNote>,
) -> String {
    let mut parts = Vec::new();

    let line_word = if rendered_count == 1 { "line" } else { "lines" };
    if rendered_count > 0 {
        parts.push(format!(
            "{} {} read from file starting from line {}.",
            rendered_count, line_word, start_line
        ));
    } else {
        parts.push("No lines read from file.".to_string());
    }

    parts.push(format!("Total lines in file: {}.", total_lines));

    if max_lines_reached {
        parts.push(format!("Max {} lines reached.", MAX_LINES));
    } else if max_bytes_reached {
        parts.push(format!("Max {} bytes reached.", MAX_BYTES));
    } else if rendered_count < requested_lines {
        parts.push("End of file reached.".to_string());
    }

    if !truncated_line_numbers.is_empty() {
        parts.push(format!(
            "Lines [{}] were truncated.",
            truncated_line_numbers
                .iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    if line_ending_style == LineEndingStyle::Mixed {
        parts.push(
            "Mixed or lone carriage-return line endings are shown as \\r. Use exact \\r\\n or \\r escapes in Edit.old_string for those lines.".to_string()
        );
    }

    if let Some(note) = encoding_note {
        parts.push(note.message());
    }

    parts.join(" ")
}

fn read_header_bytes(path: &Path, n: usize) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut buf = vec![0u8; n];
    // A single read() may return fewer bytes than requested even when more
    // data remains (network filesystems, pipes) — fill until EOF or budget.
    let mut filled = 0;
    while filled < n {
        match file.read(&mut buf[filled..])? {
            0 => break,
            k => filled += k,
        }
    }
    buf.truncate(filled);
    Ok(buf)
}

fn not_readable_message(path: &str) -> String {
    format!(
        "\"{}\" is not readable as UTF-8 text. If it is an image or video, use ReadMediaFile. For other binary formats, use Bash or an MCP tool if available.",
        path
    )
}

fn not_utf8_decodable_message(path: &str) -> String {
    format!(
        "\"{}\" is not valid UTF-8, UTF-16, or GBK/GB18030 text. Only UTF-8, UTF-16 and GBK/GB18030 text files can be read; for other encodings, convert the file to UTF-8 first (e.g. `iconv` via Bash).",
        path
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(content: &[u8]) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content).unwrap();
        f.flush().unwrap();
        f
    }

    #[test]
    fn test_read_forward_basic() {
        let f = write_temp(b"line1\nline2\nline3\n");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("1\tline1"));
        assert!(result.content.contains("2\tline2"));
        assert!(result.content.contains("3\tline3"));
    }

    #[test]
    fn test_read_forward_with_offset() {
        let f = write_temp(b"line1\nline2\nline3\n");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: Some(2),
            n_lines: Some(1),
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("2\tline2"));
        assert!(!result.content.contains("1\tline1"));
    }

    #[test]
    fn test_read_tail() {
        let f = write_temp(b"line1\nline2\nline3\nline4\nline5\n");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: Some(-3),
            n_lines: None,
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("3\tline3"));
        assert!(result.content.contains("4\tline4"));
        assert!(result.content.contains("5\tline5"));
    }

    #[test]
    fn test_read_nonexistent() {
        let temp_dir = tempfile::tempdir().unwrap();
        let nonexistent = temp_dir.path().join("nope.txt");
        drop(temp_dir);
        let result = read_file(&ReadConfig {
            path: nonexistent.to_string_lossy().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.unwrap().contains("does not exist"));
    }

    #[test]
    fn test_read_directory() {
        let dir = tempfile::tempdir().unwrap();
        let result = read_file(&ReadConfig {
            path: dir.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.unwrap().contains("is not a file"));
    }

    #[test]
    fn test_read_binary_file() {
        // An isolated zero byte fits no UTF-16 parity pattern → binary
        // (mirrors the TS 'blob.bin' case). Note [00 01 02 03] is NOT
        // binary — zeros at a single parity read as BOM-less UTF-16.
        let f = write_temp(b"plain prefix\x00\x01");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        // Binary files with NUL bytes should be detected.
        assert!(result.error.unwrap().contains("not readable"));
        assert_eq!(result.error_kind.as_deref(), Some("binary"));
    }

    #[test]
    fn test_read_line_truncation() {
        let long_line = "a".repeat(3000);
        let content = format!("{}\nshort\n", long_line);
        let f = write_temp(content.as_bytes());
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        // The long line should be truncated.
        assert!(result.content.contains("..."));
    }

    #[test]
    fn test_read_max_lines_cap() {
        let mut content = String::new();
        for i in 1..=1500 {
            content.push_str(&format!("line{}\n", i));
        }
        let f = write_temp(content.as_bytes());
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        // Should be capped at MAX_LINES.
        assert!(result.content.contains("Max") && result.content.contains("lines reached"));
    }

    #[test]
    fn test_read_no_trailing_newline() {
        let f = write_temp(b"line1\nline2\nline3");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("3\tline3"));
    }

    #[test]
    fn test_read_empty_file() {
        let f = write_temp(b"");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        assert_eq!(result.line_count, 0);
        assert!(result.content.contains("No lines read from file"));
    }

    #[test]
    fn test_read_offset_past_eof() {
        let f = write_temp(b"line1\nline2\n");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: Some(5),
            n_lines: Some(10),
        });
        assert!(result.error.is_none());
        assert!(result
            .content
            .contains("Line 5 exceeds the total number of lines (2)"));
        assert!(result.content.starts_with("<system>"));
    }

    #[test]
    fn test_read_mixed_lf_crlf_detected() {
        // A bare LF line followed by a CRLF line must detect as mixed, with
        // the trailing CR made visible — not silently stripped as pure CRLF.
        let f = write_temp(b"a\nb\r\n");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("carriage-return"));
        assert!(result.content.contains("2\tb\\r"));
    }

    #[test]
    fn test_read_pure_crlf_shown_as_lf() {
        let f = write_temp(b"a\r\nb\r\n");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("2\tb\n"));
        assert!(!result.content.contains("carriage-return"));
    }

    #[test]
    fn test_read_lone_cr_before_crlf_stays_mixed() {
        // A lone CR seen before a CRLF must not be erased by the later CRLF.
        let f = write_temp(b"a\rb\r\nc\n");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("carriage-return"));
        assert!(result.content.contains("1\ta\\rb"));
    }

    #[test]
    fn test_read_tail_detects_midline_cr() {
        // Tail reads must feed mid-line CR bytes like the forward scan does.
        let f = write_temp(b"one\nab\rcd\ntwo\n");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: Some(-3),
            n_lines: None,
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("carriage-return"));
        assert!(result.content.contains("2\tab\\rcd"));
    }

    #[test]
    fn test_read_multibyte_line_truncation_no_panic() {
        // Byte 2000 of a long CJK line splits a multi-byte char; truncation
        // must cut on a char boundary (no panic) and budget by chars.
        let long_line = "中".repeat(3000);
        let content = format!("{}\nshort\n", long_line);
        let f = write_temp(content.as_bytes());
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        let first = result.content.split('\n').next().unwrap();
        let text = first.strip_prefix("1\t").unwrap();
        assert!(text.ends_with("..."));
        assert_eq!(text.chars().count(), MAX_LINE_LENGTH);
        assert!(result.content.contains("Lines [1] were truncated"));
    }

    #[test]
    fn test_read_error_kinds() {
        let read = |path: String| {
            read_file(&ReadConfig {
                path,
                line_offset: None,
                n_lines: None,
            })
        };

        // Missing path → not_found
        let temp_dir = tempfile::tempdir().unwrap();
        let missing = temp_dir
            .path()
            .join("missing.txt")
            .to_string_lossy()
            .to_string();
        let result = read(missing);
        assert_eq!(result.error_kind.as_deref(), Some("not_found"));

        // Directory → not_a_file
        let result = read(temp_dir.path().to_str().unwrap().to_string());
        assert_eq!(result.error_kind.as_deref(), Some("not_a_file"));

        // NUL bytes → binary
        let f = write_temp(b"plain prefix\x00\x01");
        let result = read(f.path().to_str().unwrap().to_string());
        assert_eq!(result.error_kind.as_deref(), Some("binary"));

        // Undecodable garbage (not UTF-8, UTF-16, GBK, nor near-UTF-8) →
        // final invalid_utf8 refusal after the internal fallback chain.
        let f = write_temp(&[0xff; 8]);
        let result = read(f.path().to_str().unwrap().to_string());
        assert_eq!(result.error_kind.as_deref(), Some("invalid_utf8"));
        assert!(result
            .error
            .unwrap()
            .contains("not valid UTF-8, UTF-16, or GBK/GB18030 text"));

        // Success carries no kind.
        let f = write_temp(b"hello\n");
        let result = read(f.path().to_str().unwrap().to_string());
        assert!(result.error.is_none());
        assert_eq!(result.error_kind, None);
    }

    #[test]
    fn test_read_utf16le_with_bom() {
        // BOM + "中\n文\n" in UTF-16 LE.
        let mut bytes = vec![0xff, 0xfe];
        for unit in ["中", "\n", "文", "\n"] {
            let u: u16 = unit.chars().next().unwrap() as u16;
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        let f = write_temp(&bytes);
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(
            result.error.is_none(),
            "unexpected error: {:?}",
            result.error
        );
        assert_eq!(result.line_count, 2);
        assert!(result.content.contains("1\t中"));
        assert!(result.content.contains("2\t文"));
        assert!(result.content.contains("Detected file encoding: UTF-16 LE"));
    }

    #[test]
    fn test_read_utf16be_with_bom() {
        // BOM + "ab\n" in UTF-16 BE (NUL-heavy header must not read as binary).
        let mut bytes = vec![0xfe, 0xff];
        for unit in ["a", "b", "\n"] {
            let u: u16 = unit.chars().next().unwrap() as u16;
            bytes.extend_from_slice(&u.to_be_bytes());
        }
        let f = write_temp(&bytes);
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(
            result.error.is_none(),
            "unexpected error: {:?}",
            result.error
        );
        assert!(result.content.contains("1\tab"));
        assert!(result.content.contains("Detected file encoding: UTF-16 BE"));
    }

    #[test]
    fn test_read_bomless_utf16le_via_parity() {
        // "a\nb\n" as UTF-16 LE without a BOM — zeros cluster at odd indices.
        let mut bytes = Vec::new();
        for unit in ["a", "\n", "b", "\n"] {
            let u: u16 = unit.chars().next().unwrap() as u16;
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        let f = write_temp(&bytes);
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(
            result.error.is_none(),
            "unexpected error: {:?}",
            result.error
        );
        assert!(result.content.contains("1\ta"));
        assert!(result.content.contains("Detected file encoding: UTF-16 LE"));
    }

    #[test]
    fn test_read_gbk_transcodes() {
        // "中文内容\n第二行" in GBK — strict UTF-8 fails, the legacy chain
        // takes over and the note announces the transcode.
        let gbk = [
            0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd, 0x0a, 0xb5, 0xda, 0xb6, 0xfe, 0xd0,
            0xd0,
        ];
        let f = write_temp(&gbk);
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(
            result.error.is_none(),
            "unexpected error: {:?}",
            result.error
        );
        assert_eq!(result.line_count, 2);
        assert!(result.content.contains("1\t中文内容"));
        assert!(result.content.contains("2\t第二行"));
        assert!(result.content.contains("Detected GBK/GB18030 encoding"));
    }

    #[test]
    fn test_read_gbk_tail_mode() {
        let gbk = [
            0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd, 0x0a, 0xb5, 0xda, 0xb6, 0xfe, 0xd0,
            0xd0,
        ];
        let f = write_temp(&gbk);
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: Some(-1),
            n_lines: None,
        });
        assert!(
            result.error.is_none(),
            "unexpected error: {:?}",
            result.error
        );
        // The tail window keeps the file's real line number.
        assert!(result.content.contains("2\t第二行"));
        assert!(!result.content.contains("中文内容"));
        assert!(result.content.contains("Detected GBK/GB18030 encoding"));
    }

    #[test]
    fn test_read_almost_utf8_lenient() {
        // Valid UTF-8 line plus one junk byte → lenient display with the
        // replacement note.
        let mut bytes = b"\xe6\xad\xa3\xe5\xb8\xb8\n".to_vec(); // 正常\n
        bytes.push(0x88);
        let f = write_temp(&bytes);
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(
            result.error.is_none(),
            "unexpected error: {:?}",
            result.error
        );
        assert!(result.content.contains("1\t正常"));
        assert!(result.content.contains("U+FFFD"));
    }

    #[test]
    fn test_read_utf8_bom_stripped() {
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend_from_slice(b"hello\nworld\n");
        let f = write_temp(&bytes);
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("1\thello"));
        assert!(!result.content.contains('\u{FEFF}'));
    }

    #[test]
    fn test_read_utf16_too_large() {
        // BOM + UTF-16 LE payload beyond TRANSCODE_MAX_BYTES → refusal.
        let mut bytes = vec![0xff, 0xfe];
        let units = TRANSCODE_MAX_BYTES as usize / 2;
        bytes.extend((0..units).flat_map(|_| [b'a', 0x00]));
        let f = write_temp(&bytes);
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert_eq!(result.error_kind.as_deref(), Some("too_large"));
        assert!(result.error.unwrap().contains("too large to transcode"));
    }

    #[test]
    fn test_read_multibyte_char_straddling_sniff_window() {
        // Regression: a CJK char whose bytes straddle the 512-byte sniff
        // window must not make the file look binary. The header check only
        // looks for magic bytes / NULs — never UTF-8 validity — and the
        // reader decodes whole lines, so the split char is never seen alone.
        let mut content = String::new();
        // 510 ASCII bytes + newline puts the next line's first CJK char
        // across byte offset 512 (each char is 3 UTF-8 bytes).
        content.push_str(&"a".repeat(509));
        content.push('\n');
        content.push_str("中文内容测试");
        content.push('\n');
        content.push_str(&"b".repeat(100));
        content.push('\n');
        assert!(content.len() > MEDIA_SNIFF_BYTES);
        let f = write_temp(content.as_bytes());
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(
            result.error.is_none(),
            "unexpected error: {:?}",
            result.error
        );
        assert!(result.content.contains("中文内容测试"));
    }
}
