/// Read tool — reads a text file with line numbers, respecting MAX_LINES,
/// MAX_LINE_LENGTH, and MAX_BYTES limits. Supports forward reading and
/// tail reading (negative line_offset).
///
/// Mirrors `packages/agent-core/src/tools/builtin/file/read.ts`.
use crate::file_type::{detect_file_type, FileKind, MEDIA_SNIFF_BYTES};
use crate::line_endings::{detect_line_ending_style, make_carriage_returns_visible, strip_trailing_lf, LineEndingStyle};
use napi_derive::napi;
use std::fs::File;
use std::io::{self, Read};
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
}

/// Configuration for a read operation.
pub struct ReadConfig {
    pub path: String,
    pub line_offset: Option<i64>,
    pub n_lines: Option<u32>,
}

/// Read a text file, returning formatted content with line numbers.
///
/// Behavior:
///   - `line_offset` positive: start from that line (1-indexed)
///   - `line_offset` negative: read from end of file (tail mode)
///   - `n_lines`: number of lines to read (capped at MAX_LINES)
///   - Lines longer than MAX_LINE_LENGTH are truncated
///   - Output stops at MAX_BYTES
pub fn read_file(config: &ReadConfig) -> ReadResult {
    let path = Path::new(&config.path);

    // Check file exists and is a regular file.
    match std::fs::metadata(path) {
        Ok(meta) => {
            if meta.is_dir() {
                return ReadResult {
                    content: String::new(),
                    line_count: 0,
                    error: Some(format!("\"{}\" is not a file.", config.path)),
                };
            }
            // Check POSIX file type via mode bits (cross-platform).
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = meta.permissions().mode();
                if (mode & 0o170000) != 0o100000 {
                    return ReadResult {
                        content: String::new(),
                        line_count: 0,
                        error: Some(format!("\"{}\" is not a file.", config.path)),
                    };
                }
            }
        }
        Err(e) => {
            if e.kind() == io::ErrorKind::NotFound {
                return ReadResult {
                    content: String::new(),
                    line_count: 0,
                    error: Some(format!("\"{}\" does not exist.", config.path)),
                };
            }
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(e.to_string()),
            };
        }
    }

    // Sniff file type from header bytes.
    let header = match read_header_bytes(path, MEDIA_SNIFF_BYTES) {
        Ok(h) => h,
        Err(e) => {
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(e.to_string()),
            };
        }
    };

    match detect_file_type(path, &header) {
        FileKind::Image => {
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(format!(
                    "\"{}\" is an image file. Use ReadMediaFile to read image or video files.",
                    config.path
                )),
            };
        }
        FileKind::Video => {
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(format!(
                    "\"{}\" is a video file. Use ReadMediaFile to read image or video files.",
                    config.path
                )),
            };
        }
        FileKind::Unknown => {
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(not_readable_message(&config.path)),
            };
        }
        FileKind::Text => {}
    }

    // Read the full file content.
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("invalid") && msg.contains("utf") {
                return ReadResult {
                    content: String::new(),
                    line_count: 0,
                    error: Some(not_readable_message(&config.path)),
                };
            }
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(msg),
            };
        }
    };

    // Check for NUL bytes.
    if raw.as_bytes().contains(&0) {
        return ReadResult {
            content: String::new(),
            line_count: 0,
            error: Some(not_readable_message(&config.path)),
        };
    }

    let line_ending_style = detect_line_ending_style(raw.as_bytes());

    // Handle empty file.
    if raw.is_empty() {
        return ReadResult {
            content: String::new(),
            line_count: 0,
            error: None,
        };
    }

    let lines: Vec<&str> = raw.split('\n').collect();
    let total_lines = if raw.ends_with('\n') {
        lines.len().saturating_sub(1)
    } else {
        lines.len()
    };

    let line_offset = config.line_offset.unwrap_or(1);

    if line_offset < 0 {
        // Tail mode.
        let tail_count = (-line_offset) as usize;
        let tail_count = tail_count.min(MAX_LINES);
        read_tail(&lines, total_lines, tail_count, config.n_lines, line_ending_style)
    } else {
        // Forward mode.
        let start_line = line_offset as usize;
        let max_lines = config.n_lines.unwrap_or(MAX_LINES as u32) as usize;
        let max_lines = max_lines.min(MAX_LINES);
        read_forward(&lines, total_lines, start_line, max_lines, line_ending_style)
    }
}

fn read_forward(
    lines: &[&str],
    total_lines: usize,
    start_line: usize,
    max_lines: usize,
    line_ending_style: LineEndingStyle,
) -> ReadResult {
    if start_line > total_lines {
        return ReadResult {
            content: format!(
                "Line {} exceeds the total number of lines ({}).",
                start_line, total_lines
            ),
            line_count: total_lines as i32,
            error: None,
        };
    }

    let effective_limit = max_lines.min(MAX_LINES);
    let mut rendered = Vec::new();
    let mut total_bytes: usize = 0;
    let mut truncated_line_no: Option<usize> = None;
    let mut max_lines_reached = false;

    // lines is split on \n, so line N (1-indexed) is at index N-1.
    let start_idx = start_line.saturating_sub(1);
    let mut collected = 0;

    for (i, raw_line) in lines.iter().enumerate().skip(start_idx) {
        if collected >= effective_limit {
            // Check if there are more lines beyond.
            if i < lines.len() - 1 || (!lines.last().unwrap_or(&"").is_empty() && i == lines.len() - 1) {
                max_lines_reached = true;
            }
            break;
        }

        let line_no = i + 1;
        let stripped = strip_trailing_lf(raw_line);
        let (rendered_line, _was_truncated) = render_line(stripped, line_no, line_ending_style);

        let line_bytes = rendered_line.len() + 1; // +1 for \n separator
        if total_bytes + line_bytes > MAX_BYTES && !rendered.is_empty() {
            truncated_line_no = Some(line_no);
            break;
        }

        total_bytes += line_bytes;
        rendered.push(rendered_line);
        collected += 1;
    }

    let max_lines_reached = max_lines_reached || (effective_limit >= MAX_LINES && collected >= effective_limit);
    let message = finish_message(
        rendered.len(),
        start_line,
        total_lines,
        max_lines_reached,
        truncated_line_no,
        line_ending_style,
    );

    let mut content = rendered.join("\n");
    if !message.is_empty() {
        content.push('\n');
        content.push_str(&message);
    }

    ReadResult {
        content,
        line_count: total_lines as i32,
        error: None,
    }
}

fn read_tail(
    lines: &[&str],
    total_lines: usize,
    tail_count: usize,
    n_lines: Option<u32>,
    line_ending_style: LineEndingStyle,
) -> ReadResult {
    let effective_limit = n_lines
        .map(|n| (n as usize).min(MAX_LINES))
        .unwrap_or(tail_count.min(MAX_LINES));

    // Get the last `tail_count` lines.
    let start_idx = total_lines.saturating_sub(tail_count);

    let mut candidates: Vec<(usize, &str)> = Vec::new();
    for (i, raw_line) in lines.iter().enumerate() {
        if i >= start_idx && i < total_lines {
            candidates.push((i + 1, raw_line));
        }
    }

    // Slice to effective_limit (keep the most recent).
    if candidates.len() > effective_limit {
        let skip = candidates.len() - effective_limit;
        candidates = candidates.into_iter().skip(skip).collect();
    }

    // Enforce MAX_BYTES by discarding from the front (keep most recent).
    let mut rendered: Vec<String> = Vec::new();
    let mut truncated_line_no: Option<usize> = None;

    // Calculate total bytes first to see if we need to truncate.
    let candidate_bytes: Vec<usize> = candidates
        .iter()
        .map(|(line_no, raw)| {
            let stripped = strip_trailing_lf(raw);
            let (rl, _) = render_line(stripped, *line_no, line_ending_style);
            rl.len() + 1
        })
        .collect();

    let total_candidate_bytes: usize = candidate_bytes.iter().sum();

    if total_candidate_bytes > MAX_BYTES && !candidates.is_empty() {
        // Discard from front until under budget.
        let mut budget = MAX_BYTES;
        let mut start_from = 0;
        for (i, &bytes) in candidate_bytes.iter().enumerate().rev() {
            if budget >= bytes {
                budget -= bytes;
            } else {
                start_from = candidates.len() - i;
                truncated_line_no = candidates.get(start_from).map(|(ln, _)| *ln);
                break;
            }
        }
        for (line_no, raw) in candidates.iter().skip(start_from) {
            let stripped = strip_trailing_lf(raw);
            let (rl, _) = render_line(stripped, *line_no, line_ending_style);
            rendered.push(rl);
        }
    } else {
        for (line_no, raw) in &candidates {
            let stripped = strip_trailing_lf(raw);
            let (rl, _) = render_line(stripped, *line_no, line_ending_style);
            rendered.push(rl);
        }
    }

    let start_line = candidates.first().map(|(ln, _)| *ln).unwrap_or(1);
    let message = finish_message(
        rendered.len(),
        start_line,
        total_lines,
        false,
        truncated_line_no,
        line_ending_style,
    );

    let mut content = rendered.join("\n");
    if !message.is_empty() {
        content.push('\n');
        content.push_str(&message);
    }

    ReadResult {
        content,
        line_count: total_lines as i32,
        error: None,
    }
}

fn render_line(raw: &str, line_no: usize, style: LineEndingStyle) -> (String, bool) {
    let mut line = raw.to_string();
    let mut was_truncated = false;

    // For pure CRLF files, strip trailing \r.
    if style == LineEndingStyle::CrLf
        && line.ends_with('\r') {
            line.pop();
        }

    // For mixed files, make CR visible.
    if style == LineEndingStyle::Mixed {
        line = make_carriage_returns_visible(&line);
    }

    // Truncate to MAX_LINE_LENGTH.
    if line.len() > MAX_LINE_LENGTH {
        line.truncate(MAX_LINE_LENGTH);
        line.push_str("...");
        was_truncated = true;
    }

    (format!("{}\t{}", line_no, line), was_truncated)
}

fn finish_message(
    rendered_count: usize,
    start_line: usize,
    total_lines: usize,
    max_lines_reached: bool,
    truncated_line_no: Option<usize>,
    line_ending_style: LineEndingStyle,
) -> String {
    let mut parts = Vec::new();

    parts.push(format!(
        "Showing {} lines from line {} of {} total.",
        rendered_count, start_line, total_lines
    ));

    if max_lines_reached {
        parts.push(format!(
            "The output is capped at {} lines. Use line_offset and n_lines to read more.",
            MAX_LINES
        ));
    }

    if let Some(ln) = truncated_line_no {
        parts.push(format!(
            "Output truncated: line {} and beyond exceeded the {} byte limit.",
            ln, MAX_BYTES
        ));
    }

    if line_ending_style == LineEndingStyle::Mixed {
        parts.push(
            "This file has mixed line endings (CRLF and LF). Use \\r in the Edit tool for CR characters shown as \\r.".to_string()
        );
    }

    parts.join("\n")
}

fn read_header_bytes(path: &Path, n: usize) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut buf = vec![0u8; n];
    let bytes_read = file.read(&mut buf)?;
    buf.truncate(bytes_read);
    Ok(buf)
}

fn not_readable_message(path: &str) -> String {
    format!(
        "\"{}\" is not readable as UTF-8 text. If it is an image or video, use ReadMediaFile. For other binary formats, use Bash or an MCP tool if available.",
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
        let result = read_file(&ReadConfig {
            path: "/nonexistent/path/file.txt".to_string(),
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
        let f = write_temp(&[0x00, 0x01, 0x02, 0x03]);
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        // Binary files with NUL bytes should be detected.
        assert!(result.error.unwrap().contains("not readable"));
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
        assert!(result.content.contains("capped at"));
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
    }
}
