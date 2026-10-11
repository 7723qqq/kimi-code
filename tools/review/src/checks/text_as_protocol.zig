const std = @import("std");
const Io = std.Io;

const check = @import("../check.zig");
const fsutil = @import("../fsutil.zig");
const lexer = @import("../lexer.zig");
const paths = @import("../paths.zig");
const walk = @import("../walk.zig");

/// String literals compared against values that cross a layer boundary.
///
/// Message text is not an interface, but nothing stops code from treating it as
/// one: `if (reason === 'Paused after interruption')`, `switch (error) { case
/// 'Aborted by the user': ... }`. These comparisons keep working only as long
/// as nobody edits the sentence on the other side — and they break silently
/// under translation, because a localized producer no longer emits the English
/// spelling. The repository already carries stable identifiers for these cases
/// (`ReviewDecision`, `GoalPauseReason`, `SubagentCancelled` events); this check
/// points at the comparisons that still use prose.
///
/// Deliberately narrow, so the report stays actionable:
///   - only `===` / `!==` against a prose-shaped literal (a space and a capital
///     letter, or sentence punctuation), not every string comparison;
///   - only sentence-shaped literals, so `=== 'en'`, `=== 'completed'` and
///     other identifier-like values are ignored — those are protocol words, not
///     copy, and flagging them would bury the real findings.
pub fn run(ctx: *check.Context) !void {
    const files = try walk.collectFiles(ctx.alloc, ctx.io, ctx.root_dir, .{
        .skip_dirs = &paths.SKIP_DIRS,
        .suffixes = &.{ ".ts", ".tsx", ".vue" },
    });
    defer walk.freeFiles(ctx.alloc, files);

    for (files) |rel| {
        if (!isSource(rel)) continue;

        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, rel) orelse continue;
        defer ctx.alloc.free(text);

        const lexed = lexer.lex(ctx.alloc, text) catch continue;
        defer lexer.deinit(ctx.alloc, lexed);
        if (!lexed.reliable) continue;

        try scan(ctx, lexed, rel);
    }
}

fn scan(ctx: *check.Context, lexed: lexer.Lexed, rel: []const u8) !void {
    const tokens = lexed.tokens;
    var i: usize = 0;
    while (i < tokens.len) : (i += 1) {
        const token = tokens[i];
        if (token.kind != .punct) continue;
        // The lexer emits punctuation one character at a time, so `===` arrives
        // as a run of three `=` tokens rather than one operator token.
        if (!isEquals(lexed.text(token))) continue;

        var end = i;
        while (end + 1 < tokens.len and tokens[end + 1].kind == .punct and
            isEquals(lexed.text(tokens[end + 1]))) : (end += 1)
        {}

        // A single `=` is an assignment (`const X = 'text'`), not a comparison;
        // requiring a run of two or more keeps declarations out of the report.
        // `!==` lexes as `!` followed by `===`, so the `!` is not part of the run.
        if (end == i) continue;

        const operand = end + 1;
        if (operand >= tokens.len) continue;
        const other_token = tokens[operand];
        if (other_token.kind != .string) continue;

        const literal = trimQuotes(lexed.text(other_token));
        if (!looksLikeProse(literal)) continue;
        if (isProbeOrFixture(literal)) continue;

        // Report once per comparison, not once per `=` character.
        i = end;

        try ctx.report.add(.{
            .check = "text-as-protocol",
            .severity = .err,
            .file = try ctx.alloc.dupe(u8, rel),
            .line = lineOf(lexed.source, other_token.start),
            .message = try std.fmt.allocPrint(
                ctx.alloc,
                "message text '{s}' is compared as a value",
                .{literal},
            ),
            .evidence = "compare a stable identifier instead: export the constant from the package that produces the text (ReviewDecision, GoalPauseReason) and share one definition",
        });
    }
}

/// Fixture data (test tokens, probe strings) is compared in place by design and
/// is not a cross-layer contract.
fn isProbeOrFixture(literal: []const u8) bool {
    if (std.mem.indexOf(u8, literal, "sk-probe") != null) return true;
    if (std.mem.indexOf(u8, literal, "sk-good") != null) return true;
    return false;
}

fn isEquals(text: []const u8) bool {
    return text.len == 1 and text[0] == '=';
}

fn trimQuotes(raw: []const u8) []const u8 {
    if (raw.len < 2) return raw;
    return raw[1 .. raw.len - 1];
}

/// Sentence-shaped: has a space and an uppercase word, or ends in sentence
/// punctuation. Identifiers, locale codes and status words do not qualify.
fn looksLikeProse(text: []const u8) bool {
    if (text.len < 5) return false;
    var has_space = false;
    var has_upper = false;
    for (text) |c| {
        if (c == ' ') has_space = true;
        if (c >= 'A' and c <= 'Z') has_upper = true;
    }
    if (!has_space or !has_upper) return false;
    // Require the first word to be capitalized: "Paused ...", not "a b".
    if (!(text[0] >= 'A' and text[0] <= 'Z')) return false;
    return true;
}

fn lineOf(source: []const u8, offset: u32) u32 {
    var line: u32 = 1;
    var i: usize = 0;
    const limit = @min(@as(usize, offset), source.len);
    while (i < limit) : (i += 1) {
        if (source[i] == '\n') line += 1;
    }
    return line;
}

fn isSource(rel: []const u8) bool {
    if (std.mem.indexOf(u8, rel, "node_modules") != null) return false;
    if (std.mem.indexOf(u8, rel, "/test/") != null) return false;
    if (std.mem.endsWith(u8, rel, ".test.ts")) return false;
    if (std.mem.endsWith(u8, rel, ".d.ts")) return false;
    return std.mem.indexOf(u8, rel, "/locales/") == null;
}
