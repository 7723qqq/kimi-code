const std = @import("std");
const Io = std.Io;

const check = @import("../check.zig");
const fsutil = @import("../fsutil.zig");
const lexer = @import("../lexer.zig");
const paths = @import("../paths.zig");
const walk = @import("../walk.zig");

/// Accepted `.startsWith` / `.includes` matches on prose-shaped text. Suppressed
/// by name rather than by count so a new one still fails the run; see the
/// header for why the call form is a warning and not an error.
const BASELINE_PATH = "tools/review/text-as-protocol-baseline.txt";

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
///
/// The equality form is an error (zero tolerance: a new comparison is a design
/// decision). The call form below is a warning against a baseline, because a
/// handful of them legitimately match text this repository does not author —
/// `git`'s `HEAD (no branch)`, `ripgrep`'s `os error 11`, an HTTP `Bearer `
/// prefix. Suppressing those by name keeps the ones that DO cross a layer
/// boundary (`output.startsWith('Exited plan mode.')`) visible.
pub fn run(ctx: *check.Context) !void {
    const files = try walk.collectFiles(ctx.alloc, ctx.io, ctx.root_dir, .{
        .skip_dirs = &paths.SKIP_DIRS,
        .suffixes = &.{ ".ts", ".tsx", ".vue" },
    });
    defer walk.freeFiles(ctx.alloc, files);

    var baseline = try check.Baseline.load(ctx.alloc, ctx.io, ctx.root_dir, BASELINE_PATH);
    defer baseline.deinit();

    for (files) |rel| {
        if (!isSource(rel)) continue;

        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, rel) orelse continue;
        defer ctx.alloc.free(text);

        const lexed = lexer.lex(ctx.alloc, text) catch continue;
        defer lexer.deinit(ctx.alloc, lexed);
        if (!lexed.reliable) continue;

        try scan(ctx, lexed, rel);

        const calls = try scanCallForms(ctx.alloc, lexed);
        defer ctx.alloc.free(calls);
        if (calls.len == 0) continue;

        const count: u32 = @intCast(calls.len);
        const allowed = if (baseline.get(rel)) |value|
            std.fmt.parseInt(u32, value, 10) catch 0
        else
            0;

        if (count <= allowed) {
            if (count < allowed) {
                try ctx.report.add(.{
                    .check = "text-as-protocol",
                    .severity = .info,
                    .file = try ctx.alloc.dupe(u8, rel),
                    .message = try std.fmt.allocPrint(
                        ctx.alloc,
                        "baseline allows {d} text-matching call(s), found {d}; tighten it",
                        .{ allowed, count },
                    ),
                    .evidence = "lower the number in text-as-protocol-baseline.txt",
                });
            }
            continue;
        }

        for (calls) |call| {
            try ctx.report.add(.{
                .check = "text-as-protocol",
                .severity = .warn,
                .file = try ctx.alloc.dupe(u8, rel),
                .line = lineOf(lexed.source, call.offset),
                .message = try std.fmt.allocPrint(
                    ctx.alloc,
                    "message text '{s}' is matched with .{s}()",
                    .{ call.literal, call.method },
                ),
                .evidence = if (allowed == 0)
                    "matching message text is how copy becomes an interface; if this text is not ours (git, ripgrep, HTTP), add the file to text-as-protocol-baseline.txt with a reason"
                else
                    "this file is at or above its baseline; prefer a stable identifier over the sentence",
            });
        }
    }

    try baseline.reportStale(ctx, "text-as-protocol", BASELINE_PATH);
}

const MatchCall = struct {
    literal: []const u8,
    method: []const u8,
    offset: u32,
};

/// `.startsWith('Sentence here')` / `.includes(…)` / `.endsWith(…)` — the
/// call-shaped twin of the equality comparison above. `indexOf` is included;
/// `.some()` / `.filter()` over an array of sentences is not, because the
/// literal is not adjacent to the call.
fn scanCallForms(alloc: std.mem.Allocator, lexed: lexer.Lexed) ![]MatchCall {
    var out: std.ArrayList(MatchCall) = .empty;
    errdefer out.deinit(alloc);

    const tokens = lexed.tokens;
    var i: usize = 0;
    while (i < tokens.len) : (i += 1) {
        const dot = tokens[i];
        if (dot.kind != .punct or !isDot(lexed.text(dot))) continue;
        if (i + 3 >= tokens.len) continue;

        const method = tokens[i + 1];
        if (method.kind != .ident) continue;
        const method_text = lexed.text(method);
        if (!isMatchedMethod(method_text)) continue;

        const open = tokens[i + 2];
        if (open.kind != .punct or !isOpenParen(lexed.text(open))) continue;

        const arg = tokens[i + 3];
        if (arg.kind != .string) continue;

        const literal = trimQuotes(lexed.text(arg));
        if (!looksLikeProse(literal)) continue;

        // A single-token argument only: `includes('a' + b)` would otherwise
        // report a fragment of the real sentence.
        const close = tokens[i + 4];
        if (close.kind != .punct or !isCloseParen(lexed.text(close))) continue;

        try out.append(alloc, .{
            .literal = try alloc.dupe(u8, literal),
            .method = try alloc.dupe(u8, method_text),
            .offset = arg.start,
        });
    }
    return out.toOwnedSlice(alloc);
}

fn isMatchedMethod(name: []const u8) bool {
    return std.mem.eql(u8, name, "startsWith") or
        std.mem.eql(u8, name, "endsWith") or
        std.mem.eql(u8, name, "includes") or
        std.mem.eql(u8, name, "indexOf");
}

fn isDot(text: []const u8) bool {
    return text.len == 1 and text[0] == '.';
}

fn isOpenParen(text: []const u8) bool {
    return text.len == 1 and text[0] == '(';
}

fn isCloseParen(text: []const u8) bool {
    return text.len == 1 and text[0] == ')';
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

const testing = std.testing;

fn callForms(alloc: std.mem.Allocator, source: []const u8) ![]MatchCall {
    const lexed = try lexer.lex(alloc, source);
    defer lexer.deinit(alloc, lexed);
    return scanCallForms(alloc, lexed);
}

fn freeCalls(alloc: std.mem.Allocator, calls: []MatchCall) void {
    for (calls) |call| {
        alloc.free(call.literal);
        alloc.free(call.method);
    }
    alloc.free(calls);
}

test "call form detects startsWith and includes on prose" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const calls = try callForms(
        alloc,
        \\if (output.startsWith('Exited plan mode.')) return true;
        \\if (msg.includes('MiniDb is closed')) return false;
        \\
    );
    try testing.expectEqual(@as(usize, 2), calls.len);
    try testing.expectEqualStrings("Exited plan mode.", calls[0].literal);
    try testing.expectEqualStrings("startsWith", calls[0].method);
    try testing.expectEqualStrings("includes", calls[1].method);
}

test "call form ignores identifier-shaped and non-literal arguments" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const calls = try callForms(
        alloc,
        \\if (mode.startsWith('completed')) return true;
        \\if (text.includes(PREFIX)) return false;
        \\if (name.startsWith('a' + b)) return false;
        \\
    );
    try testing.expectEqual(@as(usize, 0), calls.len);
}

test "call form ignores a dot that is not a method call" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const calls = try callForms(
        alloc,
        \\const empty = nums.includes('Some Sentence Here');
        \\const other = .includes('Another Sentence Here');
        \\
    );
    // `nums.includes(…)` IS a match: the receiver does not matter, only that a
    // prose literal is being matched. The bare `.includes(` has no identifier
    // before the dot, which the token walk still treats as a call — recorded
    // here so the behaviour is a decision rather than an accident.
    try testing.expectEqual(@as(usize, 2), calls.len);
}

test "prose shape gates the call form" {
    try testing.expect(looksLikeProse("Exited plan mode."));
    try testing.expect(looksLikeProse("Bearer "));
    try testing.expect(!looksLikeProse("completed"));
    try testing.expect(!looksLikeProse("os error 11"));
    try testing.expect(!looksLikeProse("a b"));
}
