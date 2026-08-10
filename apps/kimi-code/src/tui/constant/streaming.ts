// Extracts useful string fields from partially streamed JSON tool args.
// This is intentionally a preview parser, not a full JSON parser.
export const STREAMING_ARGS_FIELD_RE =
  /"(path|file_path|command|pattern|query|url|description|title|name)"\s*:\s*"((?:\\.|[^"\\])*)"/g;

// Bounds live tool-argument previews; final tool.call payloads remain complete.
export const STREAMING_ARGS_PREVIEW_MAX_CHARS = 64 * 1024;

// Coalesces high-frequency model/tool deltas before rebuilding TUI components.
export const STREAMING_UI_FLUSH_MS = 50;

// Bounds how much of a still-growing assistant message the transient (streaming)
// renderer re-parses per flush. Re-lexing + re-wrapping the whole accumulated
// draft on the main thread every frame is O(n) per flush and O(n^2) over a long
// stream, which freezes input (ESC/Ctrl+C) and rendering on large messages. Only
// the bounded tail is rendered while streaming; the full text renders once the
// turn's assistant stream ends (non-transient pass).
export const STREAMING_MARKDOWN_TAIL_CHARS = 20 * 1024;

