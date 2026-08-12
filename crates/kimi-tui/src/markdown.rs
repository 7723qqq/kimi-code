//! Markdown rendering for the assistant transcript — a lightweight pass over
//! `pulldown-cmark` that maps block/span events onto ratatui styled spans.
//! Pure function, unit-testable without a terminal.

use pulldown_cmark::{Alignment, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line as RenderLine, Span};
use unicode_width::UnicodeWidthChar;

use crate::theme::Theme;

/// Render a markdown document into styled ratatui lines using the given
/// theme palette.
pub fn render_markdown_themed(markdown: &str, theme: Theme) -> Vec<RenderLine<'static>> {
    render_inner(markdown, theme)
}

/// Render a markdown document with the default (dark) palette.
pub fn render_markdown(markdown: &str) -> Vec<RenderLine<'static>> {
    render_inner(markdown, Theme::dark())
}

fn render_inner(markdown: &str, theme: Theme) -> Vec<RenderLine<'static>> {
    let parser = Parser::new_ext(
        markdown,
        Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES,
    );
    let mut out: Vec<RenderLine<'static>> = Vec::new();
    let mut current: Vec<Span<'static>> = Vec::new();
    // Inline emphasis / code state.
    let mut bold = false;
    let mut italic = false;
    let mut strike = false;
    // Block state.
    let mut quote_depth = 0usize;
    let mut in_code_block = false;
    let mut code_buf: Vec<u8> = Vec::new();
    // Table state (cells collect into rows until `Table` closes).
    let mut table: Option<TableBuilder> = None;

    macro_rules! flush_line {
        () => {{
            if !current.is_empty() {
                out.push(RenderLine::from(std::mem::take(&mut current)));
            } else {
                out.push(RenderLine::default());
            }
        }};
    }

    // Where inline text currently lands: a table cell, a footnote
    // definition, or the normal stream.
    macro_rules! push_inline {
        ($span:expr) => {{
            if let Some(tbl) = table.as_mut() {
                tbl.current_cell.push($span);
            } else {
                current.push($span);
            }
        }};
    }

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                flush_line!();
                current.push(Span::styled(
                    heading_prefix(level),
                    Style::default().add_modifier(Modifier::BOLD),
                ));
            }
            Event::End(TagEnd::Heading(_)) => {
                flush_line!();
                out.push(RenderLine::default());
            }
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => flush_line!(),
            Event::Start(Tag::Emphasis) => italic = true,
            Event::End(TagEnd::Emphasis) => italic = false,
            Event::Start(Tag::Strong) => bold = true,
            Event::End(TagEnd::Strong) => bold = false,
            Event::Start(Tag::Strikethrough) => strike = true,
            Event::End(TagEnd::Strikethrough) => strike = false,
            Event::Start(Tag::BlockQuote(_)) => {
                flush_line!();
                quote_depth += 1;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                flush_line!();
                quote_depth = quote_depth.saturating_sub(1);
            }
            Event::Start(Tag::List(..)) => {}
            Event::End(TagEnd::List(_)) => {}
            Event::Start(Tag::Item) => {
                let indent = "  ".repeat(quote_depth);
                current.push(Span::raw(format!("{indent}•")));
            }
            Event::End(TagEnd::Item) => flush_line!(),
            Event::Start(Tag::CodeBlock(_kind)) => {
                flush_line!();
                in_code_block = true;
                code_buf.clear();
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
                let code = String::from_utf8_lossy(&code_buf).into_owned();
                for line in code.lines() {
                    out.push(RenderLine::from(Span::styled(
                        format!("  {line}"),
                        Style::default().fg(theme.code),
                    )));
                }
                code_buf.clear();
            }
            Event::Text(text) => {
                if in_code_block {
                    code_buf.extend_from_slice(text.as_bytes());
                } else {
                    push_inline!(inline_span(text.to_string(), bold, italic, strike));
                }
            }
            Event::Code(text) => {
                push_inline!(Span::styled(text.to_string(), Style::default().fg(theme.code)));
            }
            Event::SoftBreak | Event::HardBreak => {
                if table.is_some() {
                    // Cell-internal wraps render as a space.
                    push_inline!(Span::raw(" "));
                } else {
                    flush_line!();
                }
            }
            Event::Rule => {
                flush_line!();
                out.push(RenderLine::from(Span::styled(
                    "──────────────────────────────────────────────",
                    Style::default().fg(theme.status),
                )));
            }
            Event::TaskListMarker(true) => current.push(Span::raw("☑")),
            Event::TaskListMarker(false) => current.push(Span::raw("☐")),
            Event::Start(Tag::Link { .. }) | Event::Start(Tag::Image { .. }) => {}
            Event::End(TagEnd::Link) | Event::End(TagEnd::Image) => {}
            // Inline/block HTML is intentionally dropped: the transcript is
            // rendered in a plain terminal, and raw HTML (scripts included)
            // must never leak into it.
            Event::Html(_) | Event::InlineHtml(_) => {}
            Event::InlineMath(_) | Event::DisplayMath(_) => {}
            Event::FootnoteReference(label) => {
                // `[^n]` marker the reader can match against the definition.
                push_inline!(Span::styled(
                    format!("[^{label}]"),
                    Style::default().fg(theme.quote),
                ));
            }
            Event::Start(Tag::FootnoteDefinition(label)) => {
                flush_line!();
                current.push(Span::styled(
                    format!("[^{label}]"),
                    Style::default().fg(theme.quote),
                ));
                current.push(Span::raw(" "));
            }
            Event::End(TagEnd::FootnoteDefinition) => {
                flush_line!();
                out.push(RenderLine::default());
            }
            Event::Start(Tag::DefinitionList) => {}
            Event::End(TagEnd::DefinitionList) => {}
            Event::Start(Tag::DefinitionListTitle) => {}
            Event::End(TagEnd::DefinitionListTitle) => {}
            Event::Start(Tag::DefinitionListDefinition) => {}
            Event::End(TagEnd::DefinitionListDefinition) => {}
            Event::Start(Tag::Table(aligns)) => {
                flush_line!();
                table = Some(TableBuilder::new(aligns));
            }
            Event::End(TagEnd::Table) => {
                if let Some(builder) = table.take() {
                    out.extend(render_table(&builder, theme));
                }
                out.push(RenderLine::default());
            }
            Event::Start(Tag::TableHead) => {}
            Event::End(TagEnd::TableHead) => {
                if let Some(tbl) = table.as_mut() {
                    tbl.rows.push(std::mem::take(&mut tbl.current_row));
                }
            }
            Event::Start(Tag::TableRow) => {
                if let Some(tbl) = table.as_mut() {
                    tbl.current_row.clear();
                }
            }
            Event::End(TagEnd::TableRow) => {
                if let Some(tbl) = table.as_mut() {
                    tbl.rows.push(std::mem::take(&mut tbl.current_row));
                }
            }
            Event::Start(Tag::TableCell) => {
                if let Some(tbl) = table.as_mut() {
                    tbl.current_cell.clear();
                }
            }
            Event::End(TagEnd::TableCell) => {
                if let Some(tbl) = table.as_mut() {
                    tbl.current_row
                        .push(std::mem::take(&mut tbl.current_cell));
                }
            }
            Event::Start(Tag::HtmlBlock) => {}
            Event::End(TagEnd::HtmlBlock) => {}
            Event::Start(Tag::MetadataBlock(_)) => {}
            Event::End(TagEnd::MetadataBlock(_)) => {}
        }
    }
    if in_code_block && !code_buf.is_empty() {
        let code = String::from_utf8_lossy(&code_buf).into_owned();
        for line in code.lines() {
            out.push(RenderLine::from(Span::styled(
                format!("  {line}"),
                Style::default().fg(theme.code),
            )));
        }
    }
    if !current.is_empty() {
        out.push(RenderLine::from(current));
    }
    if out.is_empty() {
        out.push(RenderLine::default());
    }
    out
}

/// The visual prefix for a heading level (h1 → `# `, h2 → `## `, …).
fn heading_prefix(level: HeadingLevel) -> String {
    let n = match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    };
    format!("{} ", "#".repeat(n))
}

/// Apply the active inline modifiers (bold/italic/strikethrough).
fn inline_span(text: String, bold: bool, italic: bool, strike: bool) -> Span<'static> {
    let mut style = Style::default();
    if bold {
        style = style.add_modifier(Modifier::BOLD);
    }
    if italic {
        style = style.add_modifier(Modifier::ITALIC);
    }
    if strike {
        style = style.add_modifier(Modifier::CROSSED_OUT);
    }
    Span::styled(text, style)
}

/// Cell content under construction for the active table.
struct TableBuilder {
    aligns: Vec<Alignment>,
    /// Rows so far; each row is a list of cell span lists.
    rows: Vec<Vec<Vec<Span<'static>>>>,
    current_row: Vec<Vec<Span<'static>>>,
    current_cell: Vec<Span<'static>>,
}

impl TableBuilder {
    fn new(aligns: Vec<Alignment>) -> Self {
        Self {
            aligns,
            rows: Vec::new(),
            current_row: Vec::new(),
            current_cell: Vec::new(),
        }
    }
}

/// The widest column a table is allowed before cells truncate with `…`.
const MAX_COLUMN_WIDTH: usize = 32;

/// Render a collected table as box-drawing rows with per-column alignment
/// and padding. Column widths are derived from the content (the widest cell
/// per column, capped at [`MAX_COLUMN_WIDTH`]) since the renderer is a pure
/// function with no terminal width; the border uses the quote (muted) tint.
fn render_table(builder: &TableBuilder, theme: Theme) -> Vec<RenderLine<'static>> {
    let ncols = builder
        .rows
        .iter()
        .map(|row| row.len())
        .max()
        .unwrap_or(0)
        .max(builder.aligns.len());
    if ncols == 0 {
        return Vec::new();
    }
    // Content width per column (capped), plus one space of padding on each
    // side of every cell.
    let mut widths = vec![0usize; ncols];
    for row in &builder.rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cell_width(cell).min(MAX_COLUMN_WIDTH));
        }
    }
    let border = Style::default().fg(theme.quote);
    let mut out = Vec::new();
    // Top border.
    out.push(RenderLine::from(Span::styled(
        top_border(&widths),
        border,
    )));
    for (row_index, row) in builder.rows.iter().enumerate() {
        let is_head = row_index == 0;
        let mut line = vec![Span::styled("│ ", border)];
        for (i, cell) in row.iter().enumerate() {
            let align = builder.aligns.get(i).copied().unwrap_or(Alignment::None);
            let mut spans = truncate_cell(cell, MAX_COLUMN_WIDTH);
            if is_head {
                spans = spans
                    .into_iter()
                    .map(|s| s.patch_style(Style::default().add_modifier(Modifier::BOLD)))
                    .collect();
            }
            line.extend(pad_cell(spans, widths[i], align));
            line.push(Span::styled(" │ ", border));
        }
        // Rows can be ragged; pad the missing trailing cells.
        for i in row.len()..ncols {
            line.push(Span::raw(" ".repeat(widths[i] + 2)));
            line.push(Span::styled(" │ ", border));
        }
        out.push(RenderLine::from(line));
        if is_head {
            // Separator between head and body.
            out.push(RenderLine::from(Span::styled(mid_border(&widths), border)));
        }
    }
    // Bottom border.
    out.push(RenderLine::from(Span::styled(
        bottom_border(&widths),
        border,
    )));
    out
}

/// The display width of a span list (unicode-aware).
fn cell_width(spans: &[Span<'static>]) -> usize {
    spans.iter().map(Span::width).sum()
}

/// Cut a cell's spans to `max` display columns, appending `…` when cut.
fn truncate_cell(spans: &[Span<'static>], max: usize) -> Vec<Span<'static>> {
    // Reserve one column for the ellipsis so a truncated cell never
    // exceeds the column width.
    let budget = max.saturating_sub(1);
    let mut out = Vec::new();
    let mut used = 0usize;
    for span in spans {
        let w = span.width();
        if used + w <= max && w > 0 {
            out.push(span.clone());
            used += w;
        } else if w > 0 {
            // Slice the overflow span to fit, character by character.
            let mut taken = String::new();
            let mut taken_w = 0usize;
            for ch in span.content.chars() {
                let ch_w = ch.width().unwrap_or(0);
                if used + taken_w + ch_w > budget {
                    break;
                }
                taken.push(ch);
                taken_w += ch_w;
            }
            if !taken.is_empty() {
                let mut s = span.clone();
                s.content = taken.into();
                out.push(s);
            }
            out.push(Span::raw("…"));
            break;
        }
    }
    out
}

/// Align a cell inside its column width (the padding is distributed by the
/// column's alignment; `None` and `Left` are left-aligned).
fn pad_cell(mut spans: Vec<Span<'static>>, width: usize, align: Alignment) -> Vec<Span<'static>> {
    let w = cell_width(&spans);
    let pad = width.saturating_sub(w);
    if pad == 0 {
        return spans;
    }
    match align {
        Alignment::Center => {
            let left = pad / 2;
            let mut out = vec![Span::raw(" ".repeat(left))];
            out.append(&mut spans);
            out.push(Span::raw(" ".repeat(pad - left)));
            out
        }
        Alignment::Right => {
            let mut out = vec![Span::raw(" ".repeat(pad))];
            out.append(&mut spans);
            out
        }
        Alignment::None | Alignment::Left => {
            spans.push(Span::raw(" ".repeat(pad)));
            spans
        }
    }
}

fn top_border(widths: &[usize]) -> String {
    let mut s = String::from("┌");
    for (i, w) in widths.iter().enumerate() {
        if i > 0 {
            s.push('┬');
        }
        s.push_str(&"─".repeat(w + 2));
    }
    s.push('┐');
    s
}

fn mid_border(widths: &[usize]) -> String {
    let mut s = String::from("├");
    for (i, w) in widths.iter().enumerate() {
        if i > 0 {
            s.push('┼');
        }
        s.push_str(&"─".repeat(w + 2));
    }
    s.push('┤');
    s
}

fn bottom_border(widths: &[usize]) -> String {
    let mut s = String::from("└");
    for (i, w) in widths.iter().enumerate() {
        if i > 0 {
            s.push('┴');
        }
        s.push_str(&"─".repeat(w + 2));
    }
    s.push('┘');
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Color;

    #[test]
    fn renders_plain_text() {
        let lines = render_markdown("hello world");
        assert_eq!(lines.len(), 1);
        let text: String = lines[0].spans.iter().map(|s| s.content.clone()).collect();
        assert_eq!(text, "hello world");
    }

    #[test]
    fn renders_headings_and_paragraphs() {
        let lines = render_markdown("# Title\n\nSome text.");
        // Heading flush yields: blank, title, blank, paragraph.
        assert!(lines.len() >= 4, "got {} lines", lines.len());
        let title: String = lines[1].spans.iter().map(|s| s.content.clone()).collect();
        assert_eq!(title, "# Title");
        let para: String = lines[3].spans.iter().map(|s| s.content.clone()).collect();
        assert_eq!(para, "Some text.");
    }

    #[test]
    fn renders_bold_and_code_spans() {
        let lines = render_markdown("**bold** and `code`");
        assert_eq!(lines.len(), 1);
        let text: String = lines[0].spans.iter().map(|s| s.content.clone()).collect();
        assert_eq!(text, "bold and code");
        // Bold span carries the BOLD modifier.
        assert!(
            lines[0]
                .spans
                .iter()
                .any(|s| s.style.add_modifier.contains(Modifier::BOLD)),
            "a span is bold"
        );
        // Code span is yellow.
        assert!(
            lines[0]
                .spans
                .iter()
                .any(|s| s.style.fg == Some(Color::Yellow)),
            "a span is code-styled"
        );
    }

    #[test]
    fn renders_code_block() {
        let lines = render_markdown("```rust\nfn main() {}\n```");
        let all: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.clone()))
            .collect();
        assert!(all.contains("fn main() {}"), "code body present: {all}");
        assert!(
            lines
                .iter()
                .any(|l| l.spans.iter().any(|s| s.style.fg == Some(Color::Yellow))),
            "code line is yellow"
        );
    }

    #[test]
    fn empty_input_yields_one_blank_line() {
        let lines = render_markdown("");
        assert_eq!(lines.len(), 1);
        assert!(lines[0].spans.is_empty());
    }

    #[test]
    fn list_items_render_bullet_prefix() {
        let lines = render_markdown("- item one\n- item two");
        let all: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.clone()))
            .collect();
        assert!(all.contains("•"), "bullet prefix: {all}");
    }

    #[test]
    fn task_list_markers_render_checked_and_unchecked() {
        let lines = render_markdown("- [x] done\n- [ ] todo");
        let all: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.clone()))
            .collect();
        assert!(all.contains("☑"), "checked marker: {all}");
        assert!(all.contains("☐"), "unchecked marker: {all}");
    }

    #[test]
    fn horizontal_rule_renders_dash_line() {
        let lines = render_markdown("---");
        let all: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.clone()))
            .collect();
        assert!(all.contains("─"), "rule dashes: {all}");
    }

    #[test]
    fn tables_render_aligned_columns() {
        let md = "| Name | Count |\n| :--- | ----: |\n| Alpha | 1 |\n| B | 200 |";
        let lines = render_markdown(md);
        let all: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.clone()))
            .collect();
        // Box borders and separator are present.
        assert!(all.contains('┌'), "top border: {all}");
        assert!(all.contains('├'), "mid border: {all}");
        assert!(all.contains('└'), "bottom border: {all}");
        // All content cells survive.
        for needle in ["Name", "Count", "Alpha", "200"] {
            assert!(all.contains(needle), "cell {needle}: {all}");
        }
        // The right-aligned Count column pads its value left: the "1" cell
        // must be wider than the "200" cell of the second row.
        let row_alpha = lines.iter().find(|l| {
            l.spans
                .iter()
                .any(|s| s.content.contains("Alpha"))
        });
        let row_b = lines.iter().find(|l| {
            l.spans.iter().any(|s| s.content.contains("200"))
        });
        let width_of = |line: &RenderLine| -> usize {
            line.spans.iter().map(|s| s.width()).sum()
        };
        let (Some(a), Some(b)) = (row_alpha, row_b) else {
            panic!("both rows present");
        };
        assert!(
            width_of(b) >= width_of(a),
            "right-aligned Count column pads; row B ({} cols) >= row A ({} cols)",
            width_of(b),
            width_of(a)
        );
    }

    #[test]
    fn table_header_is_bold() {
        let lines = render_markdown("| a | b |\n| - | - |\n| 1 | 2 |");
        let head = lines
            .iter()
            .find(|l| l.spans.iter().any(|s| s.content == "a"))
            .expect("head row");
        assert!(
            head.spans
                .iter()
                .any(|s| s.style.add_modifier.contains(Modifier::BOLD)),
            "head cell bold"
        );
    }

    #[test]
    fn long_table_cells_truncate() {
        let long = "x".repeat(100);
        let lines = render_markdown(&format!("| a |\n| - |\n| {long} |"));
        let all: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.clone()))
            .collect();
        assert!(all.contains('…'), "truncation marker: {all}");
        let cell_line = lines
            .iter()
            .find(|l| l.spans.iter().any(|s| s.content.contains('…')))
            .expect("cell line");
        let width: usize = cell_line.spans.iter().map(|s| s.width()).sum();
        assert!(
            width < 100,
            "truncated table line stays narrow: {width} cols"
        );
    }

    #[test]
    fn footnotes_render_marker_and_definition() {
        let md = "A claim[^1] here.\n\n[^1]: The supporting detail.";
        let lines = render_markdown(md);
        let all: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.clone()))
            .collect();
        assert_eq!(all.matches("[^1]").count(), 2, "marker + definition: {all}");
        assert!(all.contains("The supporting detail"), "definition: {all}");
        assert!(all.contains("A claim"), "body text: {all}");
    }

    #[test]
    fn footnote_definition_renders_before_blank_line() {
        let lines = render_markdown("Text[^2]\n\n[^2]: note here\n");
        let last_non_blank = lines
            .iter()
            .rev()
            .find(|l| !l.spans.is_empty())
            .expect("a non-blank line");
        let text: String = last_non_blank
            .spans
            .iter()
            .map(|s| s.content.clone())
            .collect();
        assert!(text.contains("note here"), "last line: {text}");
        assert!(text.starts_with("[^2]"), "definition prefix: {text}");
    }

    #[test]
    fn inline_html_is_dropped() {
        // Raw HTML (including scripts) must never reach the terminal.
        let lines = render_markdown("a <b>bold</b> <script>alert(1)</script>");
        let all: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.clone()))
            .collect();
        assert!(!all.contains("<b>") && !all.contains("<script>"), "html dropped: {all}");
        assert!(all.contains("bold") && all.contains("alert"), "text kept: {all}");
    }
}
