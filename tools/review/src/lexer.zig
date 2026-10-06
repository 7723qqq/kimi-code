const std = @import("std");

/// A TypeScript lexer, deliberately shallow: it exists to answer "is this
/// byte inside code, or inside a comment / string / regex?" and "what
/// identifiers and punctuation appear in code order?". It does not build a
/// syntax tree.
///
/// The hard part of lexing TypeScript is telling a regex literal from a
/// division operator, which needs the previous significant token. When the
/// heuristic cannot decide, the whole file is marked `reliable = false` and
/// callers must skip it: a review tool that gates CI must under-report rather
/// than report something it cannot stand behind.
pub const Kind = enum {
    ident,
    string,
    template,
    regex,
    number,
    punct,
    eof,
};

pub const Token = struct {
    kind: Kind,
    start: u32,
    end: u32,
};

pub const Lexed = struct {
    source: []const u8,
    tokens: []Token,
    /// False when the lexer met a construct it could not resolve. Consumers
    /// must not draw conclusions from an unreliable token stream.
    reliable: bool,
    fail_offset: u32 = 0,

    pub fn text(self: Lexed, token: Token) []const u8 {
        return self.source[token.start..token.end];
    }

    pub fn isIdent(self: Lexed, token: Token, name: []const u8) bool {
        return token.kind == .ident and std.mem.eql(u8, self.text(token), name);
    }

    pub fn isPunct(self: Lexed, token: Token, ch: u8) bool {
        return token.kind == .punct and token.end == token.start + 1 and self.source[token.start] == ch;
    }
};

/// Keywords after which a `/` starts a regex rather than a division.
const REGEX_PRECEDING_KEYWORDS = [_][]const u8{
    "return", "typeof", "instanceof", "in",   "of",    "new",  "delete",
    "void",   "throw",  "case",       "do",   "else",  "yield", "await",
};

pub fn lex(alloc: std.mem.Allocator, source: []const u8) !Lexed {
    var tokens: std.ArrayList(Token) = .empty;
    errdefer tokens.deinit(alloc);

    var i: usize = 0;
    var reliable = true;

    // Inside a template literal the lexer alternates between literal text and
    // the `${ ... }` expressions embedded in it. `template_depths` holds the
    // brace depth of each open interpolation, innermost last, so the `}` that
    // closes an interpolation can be told from one closing an object literal.
    // `chunk_start` is where the literal text now being scanned began.
    var template_depths: std.ArrayList(usize) = .empty;
    defer template_depths.deinit(alloc);
    var in_chunk = false;
    var chunk_start: usize = 0;

    while (i < source.len) {
        const c = source[i];

        if (in_chunk) {
            if (c == '\\') {
                i += 2;
                continue;
            }
            if (c == '`') {
                try appendTemplateChunk(alloc, &tokens, chunk_start, i);
                i += 1;
                in_chunk = false;
                continue;
            }
            if (c == '$' and i + 1 < source.len and source[i + 1] == '{') {
                try appendTemplateChunk(alloc, &tokens, chunk_start, i);
                try tokens.append(alloc, .{ .kind = .punct, .start = @intCast(i), .end = @intCast(i + 2) });
                try template_depths.append(alloc, 0);
                i += 2;
                in_chunk = false;
                continue;
            }
            i += 1;
            continue;
        }

        // Whitespace
        if (c == ' ' or c == '\t' or c == '\n' or c == '\r' or c == 0x0b or c == 0x0c) {
            i += 1;
            continue;
        }

        // Comments
        if (c == '/' and i + 1 < source.len) {
            if (source[i + 1] == '/') {
                const nl = std.mem.indexOfScalarPos(u8, source, i, '\n') orelse source.len;
                i = nl;
                continue;
            }
            if (source[i + 1] == '*') {
                const close = std.mem.indexOfPos(u8, source, i + 2, "*/") orelse {
                    reliable = false;
                    break;
                };
                i = close + 2;
                continue;
            }
        }

        // Strings
        if (c == '\'' or c == '"') {
            const start = i;
            i += 1;
            var closed = false;
            while (i < source.len) {
                if (source[i] == '\\') {
                    i += 2;
                    continue;
                }
                if (source[i] == c) {
                    i += 1;
                    closed = true;
                    break;
                }
                if (source[i] == '\n') break;
                i += 1;
            }
            if (!closed) {
                // A quote that never closes on its line is prose, not code:
                // JSX and Vue templates are full of apostrophes ("the app's
                // settings", "doesn't"). Emit it as punctuation and carry on
                // rather than abandoning the file. Every byte still gets
                // tokenized, so a reference can be over-counted but never
                // hidden — the safe direction for a check that gates CI.
                try tokens.append(alloc, .{ .kind = .punct, .start = @intCast(start), .end = @intCast(start + 1) });
                i = start + 1;
                continue;
            }
            try tokens.append(alloc, .{ .kind = .string, .start = @intCast(start), .end = @intCast(i) });
            continue;
        }

        // A backtick opens a template literal. Its literal text is scanned by
        // the `in_chunk` branch above; the `${ ... }` expressions inside it are
        // lexed as ordinary code, so identifiers they mention stay visible.
        if (c == '`') {
            i += 1;
            chunk_start = i;
            in_chunk = true;
            continue;
        }

        // Regex literal, only where a value may start
        if (c == '/' and regexAllowed(source, tokens.items)) {
            const start = i;
            i += 1;
            var in_class = false;
            var closed = false;
            while (i < source.len) {
                const rc = source[i];
                if (rc == '\\') {
                    i += 2;
                    continue;
                }
                if (rc == '\n') break;
                if (rc == '[') in_class = true;
                if (rc == ']') in_class = false;
                if (rc == '/' and !in_class) {
                    i += 1;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if (!closed) {
                reliable = false;
                break;
            }
            while (i < source.len and std.ascii.isAlphabetic(source[i])) i += 1;
            try tokens.append(alloc, .{ .kind = .regex, .start = @intCast(start), .end = @intCast(i) });
            continue;
        }

        // Identifiers
        if (isIdentStart(c)) {
            const start = i;
            while (i < source.len and isIdentPart(source[i])) i += 1;
            try tokens.append(alloc, .{ .kind = .ident, .start = @intCast(start), .end = @intCast(i) });
            continue;
        }

        // Numbers
        if (std.ascii.isDigit(c)) {
            const start = i;
            while (i < source.len and (std.ascii.isAlphanumeric(source[i]) or source[i] == '.' or source[i] == '_')) i += 1;
            try tokens.append(alloc, .{ .kind = .number, .start = @intCast(start), .end = @intCast(i) });
            continue;
        }

        // Braces inside a `${ ... }` interpolation. The one that brings the
        // depth back to zero closes the interpolation and hands the lexer back
        // to the template's literal text.
        if (template_depths.items.len > 0) {
            const last = template_depths.items.len - 1;
            if (c == '{') {
                template_depths.items[last] += 1;
            } else if (c == '}') {
                if (template_depths.items[last] == 0) {
                    try tokens.append(alloc, .{ .kind = .punct, .start = @intCast(i), .end = @intCast(i + 1) });
                    _ = template_depths.pop();
                    i += 1;
                    chunk_start = i;
                    in_chunk = true;
                    continue;
                }
                template_depths.items[last] -= 1;
            }
        }

        // Punctuation, one byte at a time: multi-character operators never
        // matter for the questions this lexer answers.
        try tokens.append(alloc, .{ .kind = .punct, .start = @intCast(i), .end = @intCast(i + 1) });
        i += 1;
    }

    // A template that never closes, or an interpolation left open, means the
    // token stream cannot be trusted.
    if (in_chunk or template_depths.items.len > 0) reliable = false;

    try tokens.append(alloc, .{ .kind = .eof, .start = @intCast(source.len), .end = @intCast(source.len) });
    return .{
        .source = source,
        .tokens = try tokens.toOwnedSlice(alloc),
        .reliable = reliable,
    };
}

pub fn deinit(alloc: std.mem.Allocator, lexed: Lexed) void {
    alloc.free(lexed.tokens);
}

fn isIdentStart(c: u8) bool {
    return std.ascii.isAlphabetic(c) or c == '_' or c == '$' or c >= 0x80;
}

/// Emit the literal text between two interpolation points of a template. The
/// backticks and `${` are not part of it; an empty chunk emits nothing.
fn appendTemplateChunk(
    alloc: std.mem.Allocator,
    tokens: *std.ArrayList(Token),
    start: usize,
    end: usize,
) !void {
    if (end <= start) return;
    try tokens.append(alloc, .{ .kind = .template, .start = @intCast(start), .end = @intCast(end) });
}

fn isIdentPart(c: u8) bool {
    return isIdentStart(c) or std.ascii.isDigit(c);
}

/// Punctuation after which a `/` opens a regex literal rather than dividing.
///
/// Deliberately an allowlist rather than "anything but `)`, `]`, `}`". Two
/// shapes force it narrow:
///
///   * `<` opens a JSX tag, so `</div>` would read as a regex that never
///     closes and mark every `.tsx` file unreliable;
///   * `+` and `-` end a postfix `x++`, so `ordinal++ / 1000` would do the
///     same to ordinary arithmetic.
///
/// A `/` misread as division only costs a few spurious identifiers, while a
/// regex misread as division swallows code, so the narrow list is the safe
/// side of the trade.
const REGEX_PRECEDING_PUNCT = [_]u8{
    '(', ',', '=', ':', '[', '!', '&', '|', '?', ';', '{',
};

fn regexAllowed(source: []const u8, tokens: []const Token) bool {
    if (tokens.len == 0) return true;
    const prev = tokens[tokens.len - 1];
    return switch (prev.kind) {
        .number, .string, .template, .regex => false,
        .ident => blk: {
            const word = source[prev.start..prev.end];
            for (REGEX_PRECEDING_KEYWORDS) |kw| {
                if (std.mem.eql(u8, word, kw)) break :blk true;
            }
            break :blk false;
        },
        .punct => for (REGEX_PRECEDING_PUNCT) |ch| {
            if (source[prev.start] == ch) break true;
        } else false,
        .eof => true,
    };
}

const testing = std.testing;

test "comments and strings are skipped, identifiers survive" {
    const alloc = testing.allocator;
    const src =
        \\// export function ghost() {}
        \\const a = "export function alsoGhost() {}";
        \\export function real() {}
    ;
    const lexed = try lex(alloc, src);
    defer deinit(alloc, lexed);

    try testing.expect(lexed.reliable);
    var found_real = false;
    var found_ghost = false;
    for (lexed.tokens) |t| {
        if (lexed.isIdent(t, "real")) found_real = true;
        if (lexed.isIdent(t, "ghost")) found_ghost = true;
    }
    try testing.expect(found_real);
    try testing.expect(!found_ghost);
}

test "template literals swallow their contents including nested braces" {
    const alloc = testing.allocator;
    const src = "const s = `a ${ b } c`; const after = 1;";
    const lexed = try lex(alloc, src);
    defer deinit(alloc, lexed);

    try testing.expect(lexed.reliable);
    var found_after = false;
    for (lexed.tokens) |t| {
        if (lexed.isIdent(t, "after")) found_after = true;
    }
    try testing.expect(found_after);
}

test "a regex containing a quote or a comment marker does not derail the lexer" {
    const alloc = testing.allocator;
    const src = "const re = /don't \\/\\/ stop/; const after = 1;";
    const lexed = try lex(alloc, src);
    defer deinit(alloc, lexed);

    try testing.expect(lexed.reliable);
    var found_after = false;
    for (lexed.tokens) |t| {
        if (lexed.isIdent(t, "after")) found_after = true;
    }
    try testing.expect(found_after);
}

test "division is not mistaken for a regex" {
    const alloc = testing.allocator;
    const src = "const x = a / b / c; const after = 1;";
    const lexed = try lex(alloc, src);
    defer deinit(alloc, lexed);

    try testing.expect(lexed.reliable);
    var found_after = false;
    for (lexed.tokens) |t| {
        if (lexed.isIdent(t, "after")) found_after = true;
    }
    try testing.expect(found_after);
}

test "a JSX closing tag is not mistaken for a regex" {
    const alloc = testing.allocator;
    const src =
        \\export function Widget() {
        \\  return <div className="x">{value}</div>;
        \\}
    ;
    const lexed = try lex(alloc, src);
    defer deinit(alloc, lexed);

    try testing.expect(lexed.reliable);
    var found_value = false;
    for (lexed.tokens) |t| {
        if (lexed.isIdent(t, "value")) found_value = true;
    }
    try testing.expect(found_value);
}

test "identifiers inside a template interpolation stay visible" {
    const alloc = testing.allocator;
    const src =
        \\const full = `${PREFIX}${sanitizeName(server)}__${sanitizeName(tool)}`;
        \\const after = 1;
    ;
    const lexed = try lex(alloc, src);
    defer deinit(alloc, lexed);

    try testing.expect(lexed.reliable);
    var seen: usize = 0;
    var found_after = false;
    for (lexed.tokens) |t| {
        if (lexed.isIdent(t, "sanitizeName")) seen += 1;
        if (lexed.isIdent(t, "after")) found_after = true;
    }
    try testing.expectEqual(@as(usize, 2), seen);
    try testing.expect(found_after);
}

test "a nested template inside an interpolation closes in the right order" {
    const alloc = testing.allocator;
    const src =
        \\const s = `${ `${inner}` } tail`;
        \\const after = 1;
    ;
    const lexed = try lex(alloc, src);
    defer deinit(alloc, lexed);

    try testing.expect(lexed.reliable);
    var found_inner = false;
    var found_after = false;
    for (lexed.tokens) |t| {
        if (lexed.isIdent(t, "inner")) found_inner = true;
        if (lexed.isIdent(t, "after")) found_after = true;
    }
    try testing.expect(found_inner);
    try testing.expect(found_after);
}

test "an unterminated template marks the file unreliable" {
    const alloc = testing.allocator;
    const lexed = try lex(alloc, "const s = `never closed");
    defer deinit(alloc, lexed);
    try testing.expect(!lexed.reliable);
}

test "an unterminated block comment marks the file unreliable" {
    const alloc = testing.allocator;
    const lexed = try lex(alloc, "const s = 1; /* never closed");
    defer deinit(alloc, lexed);
    try testing.expect(!lexed.reliable);
}

test "an apostrophe in prose does not abandon the file" {
    const alloc = testing.allocator;
    const src =
        \\<!-- The app's settings dialog, which doesn't render until mounted. -->
        \\<script setup lang="ts">
        \\import { getIcon } from './icons';
        \\</script>
    ;
    const lexed = try lex(alloc, src);
    defer deinit(alloc, lexed);

    try testing.expect(lexed.reliable);
    var found = false;
    for (lexed.tokens) |t| {
        if (lexed.isIdent(t, "getIcon")) found = true;
    }
    try testing.expect(found);
}

test "isPunct matches single-character punctuation" {
    const alloc = testing.allocator;
    const lexed = try lex(alloc, "catch {}");
    defer deinit(alloc, lexed);

    try testing.expect(lexed.isPunct(lexed.tokens[1], '{'));
    try testing.expect(lexed.isPunct(lexed.tokens[2], '}'));
    try testing.expect(!lexed.isPunct(lexed.tokens[0], '{'));
}
