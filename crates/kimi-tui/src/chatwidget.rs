//! Chat widget — renders the transcript + input panes (G-4 chatwidget
//! component tree, step 1). Extracted from `app.rs` so the app shell stays
//! thin and the widget can grow independently (tool cards, approval dialogs,
//! media blocks) against a TestBackend contract.

use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line as RenderLine, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::app::{TranscriptEntry, TranscriptKind};
use crate::i18n::t;
use crate::t;
use crate::terminal_image::ImageProtocol;
use crate::theme::Theme;

/// An inline image in the rendered transcript: the escape sequence plus the
/// index of the first reserved line in the render output. Text flows around
/// `rows` reserved blank lines; the app shell injects `sequence` straight
/// into the terminal after the frame flushes (ratatui strips control
/// characters from cell symbols, so the sequence can never ride in a
/// `Paragraph`).
#[derive(Debug, Clone, PartialEq)]
pub struct ImageBlock {
    pub sequence: String,
    pub protocol: ImageProtocol,
    /// Index into the render-line list where the image top sits.
    pub line_index: usize,
    /// Terminal rows the image occupies (reserved blank lines).
    pub rows: u16,
}

/// Where an inline image must be drawn this frame: the escape sequence plus
/// its 1-based absolute terminal coordinates (cursor position `\x1b[row;colH`).
#[derive(Debug, Clone, PartialEq)]
pub struct ImagePlacement {
    pub sequence: String,
    pub protocol: ImageProtocol,
    pub row: u16,
    pub col: u16,
}

/// Draw the chat layout: a scrollable transcript on top, an optional todo
/// panel (resume + `session.todo.updated`), the input line (with the
/// session id) below, and the footer status bar at the bottom, with the
/// cursor at the editing position. When a slash-command completion popup is
/// active it is drawn over the bottom of the chat pane. An empty todo list
/// renders no panel rows, so the layout costs nothing. Returns the inline
/// image placements the caller must write to the terminal after the frame
/// flushes (empty when the terminal/transcript has no images).
#[allow(clippy::too_many_arguments)]
pub fn render_frame(
    frame: &mut ratatui::Frame<'_>,
    transcript: &[TranscriptEntry],
    input: &str,
    cursor: usize,
    session_id: &str,
    scroll: u16,
    theme: Theme,
    footer: &crate::footer::FooterInfo,
    completion: Option<&crate::app::CompletionState>,
    input_hint: Option<&str>,
    thinking_expanded: bool,
    todos: &[(String, String)],
) -> Vec<ImagePlacement> {
    // Todo panel rows above the input; capped so it can't monopolize the
    // pane (TS TodoPanel parity, simplified).
    let todo_height = (todos.len() as u16).min(MAX_TODO_ROWS);
    let has_todo = todo_height > 0;
    let mut constraints = vec![Constraint::Min(3)];
    if has_todo {
        constraints.push(Constraint::Length(todo_height));
    }
    constraints.push(Constraint::Length(3));
    constraints.push(Constraint::Length(2));
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(frame.area());
    let input_index = if has_todo { 2 } else { 1 };
    let footer_index = input_index + 1;
    let (lines, image_blocks) = styled_lines_with_images(
        transcript,
        theme,
        thinking_expanded,
        chunks[0].width as usize,
    );
    let placements = image_placements(&image_blocks, chunks[0], scroll);
    let chat = Paragraph::new(lines)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(t("tui.chat.title")),
        )
        .scroll((scroll, 0));
    // The completion popup overlays the bottom of the chat pane.
    if let Some(state) = completion {
        let popup_lines: Vec<RenderLine<'static>> = state
            .matches
            .iter()
            .enumerate()
            .map(|(i, (cmd, desc))| {
                let selected = i == state.selected;
                // Command + dimmed description in a second column.
                let prefix = if selected { "❯" } else { " " };
                RenderLine::from(vec![
                    Span::styled(
                        format!("  {prefix} {cmd}"),
                        Style::default().fg(if selected {
                            theme.assistant
                        } else {
                            theme.status
                        }),
                    ),
                    Span::styled(format!("  {desc}"), Style::default().fg(theme.thinking)),
                ])
            })
            .collect();
        let popup = Paragraph::new(popup_lines)
            .block(Block::default().borders(Borders::ALL).title("commands"));
        let popup_height = (state.matches.len() as u16 + 2).min(chunks[0].height);
        let area = ratatui::layout::Rect {
            x: chunks[0].x,
            y: chunks[0].y + chunks[0].height - popup_height,
            width: chunks[0].width,
            height: popup_height,
        };
        frame.render_widget(chat, chunks[0]);
        // Overlay the popup on the bottom of the chat pane.
        frame.render_widget(popup, area);
    } else {
        frame.render_widget(chat, chunks[0]);
    }
    // Todo panel: one `(marker, title)` row per item, dim/status-styled,
    // titles truncated to the pane width.
    if has_todo {
        let rows: Vec<RenderLine<'static>> = todos
            .iter()
            .map(|(title, status)| todo_line(title, status, theme, chunks[1].width))
            .collect();
        frame.render_widget(Paragraph::new(rows), chunks[1]);
    }
    // Input line: the draft plus an optional dim argument hint (`/cmd `).
    let mut input_spans = vec![Span::raw(input.to_string())];
    if let Some(hint) = input_hint {
        input_spans.push(Span::styled(
            hint.to_string(),
            Style::default().fg(theme.thinking),
        ));
    }
    let input_widget = Paragraph::new(RenderLine::from(input_spans)).block(
        Block::default()
            .borders(Borders::ALL)
            .title(t!("tui.chat.inputTitle", session_id)),
    );
    frame.render_widget(input_widget, chunks[input_index]);
    // Footer status strip + rotating tip.
    let footer_widget =
        Paragraph::new(crate::footer::footer_lines(footer, theme, chunks[footer_index].width));
    frame.render_widget(footer_widget, chunks[footer_index]);
    // Place the terminal cursor at the input editing position (inside the
    // border). Multi-line input: row/col come from the cursor's line.
    let (line, col) = crate::bottom_pane::cursor_line_col(input, cursor);
    let input_row = chunks[input_index].y + 1 + line as u16;
    let input_col = chunks[input_index].x + 1 + col as u16;
    frame.set_cursor_position((input_col, input_row));
    placements
}

/// The todo panel caps at this many visible rows (older entries scroll off
/// the pane; the engine list itself stays intact).
const MAX_TODO_ROWS: u16 = 5;

/// One todo panel row: `• title` (pending), `… title` (in_progress), `✓
/// title` (completed), truncated to the pane width (TS TodoPanel parity).
fn todo_line(title: &str, status: &str, theme: Theme, width: u16) -> RenderLine<'static> {
    let truncated = truncate_hint(title, width.saturating_sub(2) as usize);
    let (marker, color) = match status {
        "completed" => ("✓ ", theme.thinking),
        "in_progress" => ("… ", theme.status),
        _ => ("• ", theme.status),
    };
    RenderLine::from(Span::styled(
        format!("{marker}{truncated}"),
        Style::default().fg(color),
    ))
}

/// Largest scroll offset that still keeps the last transcript line visible
/// in a `pane_height`-tall chat pane (minus its borders).
pub fn max_scroll(total: usize, pane_height: u16) -> usize {
    total.saturating_sub(pane_height.saturating_sub(2) as usize)
}

/// Map reserved image blocks to the absolute screen coordinates (1-based)
/// they must be drawn at this frame, honoring the scroll offset. Images
/// scrolled above or below the chat pane's content area are skipped (they
/// either already scrolled away or haven't scrolled into view yet).
pub fn image_placements(
    blocks: &[ImageBlock],
    pane: Rect,
    scroll: u16,
) -> Vec<ImagePlacement> {
    // The content area sits inside the pane's 1-cell border.
    let content_top = pane.y + 1;
    let content_height = pane.height.saturating_sub(2);
    let content_bottom = content_top + content_height;
    blocks
        .iter()
        .filter_map(|b| {
            let line = b.line_index as u16;
            if line < scroll {
                return None; // scrolled above the viewport
            }
            let top = content_top + line - scroll;
            if top >= content_bottom {
                return None; // below the viewport
            }
            Some(ImagePlacement {
                sequence: b.sequence.clone(),
                protocol: b.protocol,
                row: top + 1, // CUP is 1-based
                col: pane.x + 2,
            })
        })
        .collect()
}

/// Map transcript entries to styled render lines (role → prefix + style).
/// Assistant (and live-streaming) text is markdown-rendered; everything else
/// stays plain. Colors come from the resolved theme palette. `pane_width`
/// drives thinking folding; `thinking_expanded` (Ctrl-O) shows the full
/// reasoning instead of the tail preview.
pub fn styled_lines(
    transcript: &[TranscriptEntry],
    theme: Theme,
    thinking_expanded: bool,
    pane_width: usize,
) -> Vec<RenderLine<'static>> {
    styled_lines_with_images(transcript, theme, thinking_expanded, pane_width).0
}

/// `styled_lines` plus the inline-image blocks. For each rendered image the
/// output reserves `rows` blank lines (so text flows around it) and records
/// an `ImageBlock` the app shell uses to inject the escape sequence after
/// the frame flushes.
fn styled_lines_with_images(
    transcript: &[TranscriptEntry],
    theme: Theme,
    thinking_expanded: bool,
    pane_width: usize,
) -> (Vec<RenderLine<'static>>, Vec<ImageBlock>) {
    let mut out = Vec::new();
    let mut images = Vec::new();
    for entry in transcript {
        match entry {
            TranscriptEntry::Task(task) => {
                // Task / subagent card: `⚙ task <id> <description> — <status>`
                // with an elapsed duration once terminated (TS
                // `background-agent-status` parity, simplified).
                let mut header = format!("⚙ task {}", task.task_id);
                if !task.description.is_empty() {
                    header.push_str(&format!(" {}", task.description));
                }
                let status = if task.ended {
                    task.status.as_str()
                } else {
                    "running"
                };
                header.push_str(&format!(" — {status}"));
                if let (Some(started), Some(ended)) = (task.started_at_ms, task.ended_at_ms) {
                    header.push_str(&format!(
                        " [{}]",
                        format_duration(std::time::Duration::from_millis(
                            ended.saturating_sub(started)
                        ))
                    ));
                }
                out.push(RenderLine::from(Span::styled(
                    header,
                    Style::default().fg(theme.tool),
                )));
            }
            TranscriptEntry::ToolCall(tc) => {
                // Tool-call card: `⚙ name(args)` header (or `❓` for
                // AskUserQuestion), then the result when settled
                // (collapsed -> preview + `[+]`).
                let marker = if tc.is_question { "❓" } else { "⚙" };
                let color = if tc.is_question {
                    theme.status
                } else {
                    theme.tool
                };
                let mut header = format!("{marker} {}({})", tc.tool_name, preview(&tc.args, 60));
                if let Some(duration) = tc.duration {
                    header.push_str(&format!(" [{}]", format_duration(duration)));
                }
                out.push(RenderLine::from(Span::styled(
                    header,
                    Style::default().fg(color),
                )));
                // Inline image: reserve `rows` blank lines (the text flows
                // around them) and record the block for post-flush
                // injection. The caption/result text renders below.
                if let Some(image) = &tc.image {
                    let line_index = out.len();
                    for _ in 0..image.rows {
                        out.push(RenderLine::from(""));
                    }
                    images.push(ImageBlock {
                        sequence: image.sequence.clone(),
                        protocol: image.protocol,
                        line_index,
                        rows: image.rows,
                    });
                }
                if let Some(result) = &tc.result {
                    if tc.collapsed {
                        // Collapsed body: the tool-result chip when the tool
                        // has one, else the plain preview.
                        let body =
                            crate::reports::tool_result_chip(&tc.tool_name, result, tc.is_error)
                                .unwrap_or_else(|| preview(result, 100));
                        out.push(RenderLine::from(Span::styled(
                            format!("  -> {body} [+]"),
                            Style::default().fg(if tc.is_error {
                                theme.error
                            } else {
                                theme.status
                            }),
                        )));
                    } else {
                        for (i, line) in result.lines().enumerate() {
                            out.push(RenderLine::from(Span::styled(
                                format!("  {} {line}", if i == 0 { "->" } else { " " }),
                                Style::default().fg(if tc.is_error {
                                    theme.error
                                } else {
                                    theme.status
                                }),
                            )));
                        }
                    }
                }
            }
            TranscriptEntry::Line(line) => match line.kind {
                TranscriptKind::Assistant | TranscriptKind::Streaming => {
                    out.extend(crate::markdown::render_markdown_themed(&line.text, theme));
                }
                TranscriptKind::User => out.push(RenderLine::from(Span::styled(
                    format!("✨ {}", line.text),
                    Style::default().fg(theme.user).add_modifier(Modifier::BOLD),
                ))),
                // Reasoning is transient and dimmer than the visible stream;
                // long reasoning folds to a tail preview with a `… (+N
                // lines)` marker so it can't monopolize the viewport
                // (Ctrl-O expands, TS `ThinkingComponent` parity).
                TranscriptKind::Thinking => {
                    for row in thinking_lines(&line.text, thinking_expanded, pane_width) {
                        out.push(RenderLine::from(Span::styled(
                            row,
                            Style::default()
                                .fg(theme.thinking)
                                .add_modifier(Modifier::ITALIC),
                        )));
                    }
                }
                TranscriptKind::Tool => {
                    let is_question = line.text.contains("AskUserQuestion");
                    out.push(RenderLine::from(Span::styled(
                        format!("  {} {}", if is_question { "❓" } else { "⚙" }, line.text),
                        Style::default().fg(if is_question {
                            theme.status
                        } else {
                            theme.tool
                        }),
                    )));
                }
                TranscriptKind::Status => out.push(RenderLine::from(Span::styled(
                    line.text.clone(),
                    Style::default().fg(theme.status),
                ))),
                TranscriptKind::Error => out.push(RenderLine::from(Span::styled(
                    line.text.clone(),
                    Style::default().fg(theme.error),
                ))),
            },
        }
    }
    (out, images)
}

/// Bounded single-line preview (`…` when truncated).
fn preview(text: &str, max: usize) -> String {
    let text = text.replace('\n', " ");
    if text.chars().count() <= max {
        text
    } else {
        let cut: String = text.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// `123ms` under a second, `1.2s` above (tool-call duration label).
fn format_duration(d: std::time::Duration) -> String {
    let ms = d.as_millis();
    if ms >= 1000 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        format!("{ms}ms")
    }
}

/// Reasoning that wraps to more rows than this folds to a tail preview with
/// a `… (+N lines)` marker (TS `THINKING_PREVIEW_LINES` parity).
const THINKING_PREVIEW_LINES: usize = 2;

/// Wrap `text` into `width`-char rows (character-level truncation, TS
/// pi-tui `Text` parity). Paragraph re-wraps afterwards; rows are ≤ `width`
/// so that second wrap is a no-op.
fn wrap_text(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut out = Vec::new();
    for para in text.split('\n') {
        let chars: Vec<char> = para.chars().collect();
        let mut start = 0;
        while start < chars.len() {
            let end = (start + width).min(chars.len());
            out.push(chars[start..end].iter().collect());
            start = end;
        }
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

/// Truncate a hint row to `width` chars, appending `…` when cut (TS
/// `truncateToWidth` parity).
fn truncate_hint(hint: &str, width: usize) -> String {
    if hint.chars().count() <= width {
        hint.to_string()
    } else {
        let mut cut: String = hint.chars().take(width.saturating_sub(1)).collect();
        cut.push('…');
        cut
    }
}

/// Rows for a thinking line (TS `ThinkingComponent` parity): the full text
/// when expanded or short; otherwise the last `THINKING_PREVIEW_LINES` rows
/// plus a `… (+N lines, ctrl+o to expand)` marker row.
fn thinking_lines(text: &str, expanded: bool, width: usize) -> Vec<String> {
    let wrapped = wrap_text(text, width);
    if expanded || wrapped.len() <= THINKING_PREVIEW_LINES {
        return wrapped;
    }
    let mut out = wrapped[wrapped.len() - THINKING_PREVIEW_LINES..].to_vec();
    let remaining = wrapped.len() - THINKING_PREVIEW_LINES;
    out.push(truncate_hint(
        &t!("tui.messages.thinking.expandHint", remaining),
        width,
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::Theme;

    #[test]
    fn collapsed_tool_lines_show_expand_marker() {
        let transcript = vec![TranscriptEntry::ToolCall(crate::app::ToolCallEntry {
            tool_call_id: "t1".into(),
            tool_name: "Bash".into(),
            args: "{}".into(),
            result: Some("very long result output".repeat(20)),
            is_error: false,
            is_question: false,
            collapsed: true,
            duration: None,
            image: None,
        })];
        let lines = styled_lines(&transcript, Theme::dark(), false, 60);
        // Header + collapsed result preview with the expand marker.
        let all: String = lines.iter().map(|l| l.to_string()).collect();
        assert!(all.contains("[+]"), "expand marker: {all}");
        assert!(all.contains("⚙ Bash"), "tool header: {all}");
    }

    #[test]
    fn expanded_tool_result_renders_multiple_rows() {
        let transcript = vec![TranscriptEntry::ToolCall(crate::app::ToolCallEntry {
            tool_call_id: "t1".into(),
            tool_name: "Bash".into(),
            args: "{}".into(),
            result: Some("line1\nline2\nline3".into()),
            is_error: false,
            is_question: false,
            collapsed: false,
            duration: None,
            image: None,
        })];
        let lines = styled_lines(&transcript, Theme::dark(), false, 60);
        // Header + one row per result line.
        assert_eq!(lines.len(), 4, "header + 3 result rows: {lines:?}");
        assert!(lines[1].to_string().contains("line1"));
        assert!(lines[3].to_string().contains("line3"));
    }

    #[test]
    fn long_thinking_folds_to_tail_preview() {
        // Short thinking passes through verbatim.
        assert_eq!(thinking_lines("hmm", false, 60), vec!["hmm".to_string()]);
        // A long block folds to the last PREVIEW_LINES rows plus a marker
        // row with the hidden line count (Ctrl-O expands the full text).
        let long = "x".repeat(500);
        let folded = thinking_lines(&long, false, 60);
        assert_eq!(folded.len(), 3, "2 tail rows + marker: {folded:?}");
        assert!(folded[0].ends_with('x'), "tail row: {folded:?}");
        assert!(
            folded[2].contains("+7 lines, ctrl+o"),
            "marker: {:?}",
            folded[2]
        );
        // Expanded renders every wrapped row with no marker.
        let expanded = thinking_lines(&long, true, 60);
        assert!(expanded.len() > 3, "expanded: {}", expanded.len());
        assert!(!expanded.iter().any(|r| r.contains("ctrl+o")));
        // The marker truncates to the pane width (`…` when cut).
        let narrow = thinking_lines(&long, false, 20);
        assert!(narrow.last().unwrap().chars().count() <= 20);
    }

    #[test]
    fn wrap_text_splits_on_width_and_newlines() {
        assert_eq!(wrap_text("abcde", 2), vec!["ab", "cd", "e"]);
        assert_eq!(wrap_text("ab\ncde", 3), vec!["ab", "cde"]);
        // Empty text renders one empty row (Paragraph-safe).
        assert_eq!(wrap_text("", 10), vec![""]);
        // A width of zero degrades to one-char rows instead of looping.
        assert_eq!(wrap_text("ab", 0), vec!["a", "b"]);
    }

    #[test]
    fn durations_format_readably() {
        assert_eq!(
            format_duration(std::time::Duration::from_millis(250)),
            "250ms"
        );
        assert_eq!(
            format_duration(std::time::Duration::from_millis(1200)),
            "1.2s"
        );
    }

    #[test]
    fn tool_card_header_shows_duration() {
        let transcript = vec![TranscriptEntry::ToolCall(crate::app::ToolCallEntry {
            tool_call_id: "t1".into(),
            tool_name: "Bash".into(),
            args: "{}".into(),
            result: None,
            is_error: false,
            is_question: false,
            duration: Some(std::time::Duration::from_millis(1200)),
            collapsed: false,
            image: None,
        })];
        let lines = styled_lines(&transcript, Theme::dark(), false, 60);
        let all: String = lines.iter().map(|l| l.to_string()).collect();
        assert!(all.contains("[1.2s]"), "header: {all}");
    }

    #[test]
    fn todo_lines_render_markers_and_truncate() {
        let theme = Theme::dark();
        let pending = todo_line("fix the bug", "pending", theme, 40);
        assert_eq!(pending.to_string(), "• fix the bug");
        let in_progress = todo_line("write tests", "in_progress", theme, 40);
        assert_eq!(in_progress.to_string(), "… write tests");
        let done = todo_line("ship it", "completed", theme, 40);
        assert_eq!(done.to_string(), "✓ ship it");
        // Long titles truncate to the pane width (`…` when cut).
        let long = todo_line(&"x".repeat(100), "pending", theme, 10);
        assert!(long.to_string().chars().count() <= 10, "{}", long);
    }

    #[test]
    fn inline_image_reserves_rows_and_maps_to_placement() {
        use crate::terminal_image::{ImageProtocol, RenderedImage};
        let transcript = vec![TranscriptEntry::ToolCall(crate::app::ToolCallEntry {
            tool_call_id: "t1".into(),
            tool_name: "ReadMediaFile".into(),
            args: "{}".into(),
            result: Some("image (image/png, 12 B) /tmp/a.png".into()),
            is_error: false,
            is_question: false,
            duration: None,
            collapsed: false,
            image: Some(RenderedImage {
                sequence: "\x1b_Ga=T;xxx\x1b\\".into(),
                rows: 3,
                image_id: Some(1),
                protocol: ImageProtocol::Kitty,
            }),
        })];
        let (lines, blocks) =
            styled_lines_with_images(&transcript, Theme::dark(), false, 60);
        // Header + 3 reserved blank rows + 1 caption row.
        assert_eq!(lines.len(), 5, "{lines:?}");
        assert_eq!(lines[1].to_string(), "", "reserved row is blank");
        let block = &blocks[0];
        assert_eq!(block.line_index, 1, "image sits right under the header");
        assert_eq!(block.rows, 3);
        assert_eq!(block.protocol, ImageProtocol::Kitty);
        // A scrolled-out image produces no placement.
        let pane = Rect::new(0, 0, 60, 12);
        assert!(image_placements(std::slice::from_ref(block), pane, 5).is_empty());
        // Visible image maps to the 1-based screen row/col: content_top(1)
        // + line_index(1) → row 3, first content column → col 2.
        let placements = image_placements(std::slice::from_ref(block), pane, 0);
        assert_eq!(placements.len(), 1);
        assert_eq!(placements[0].row, 3);
        assert_eq!(placements[0].col, 2);
        assert!(placements[0].sequence.starts_with("\x1b_G"));
    }

    #[test]
    fn images_without_protocol_stay_text_only() {
        // A tool card with no image renders exactly like before.
        let transcript = vec![TranscriptEntry::ToolCall(crate::app::ToolCallEntry {
            tool_call_id: "t1".into(),
            tool_name: "Bash".into(),
            args: "{}".into(),
            result: Some("ok".into()),
            is_error: false,
            is_question: false,
            duration: None,
            collapsed: false,
            image: None,
        })];
        let (lines, blocks) =
            styled_lines_with_images(&transcript, Theme::dark(), false, 60);
        assert_eq!(lines.len(), 2, "header + result: {lines:?}");
        assert!(blocks.is_empty());
    }
}
