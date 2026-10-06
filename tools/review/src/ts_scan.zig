const std = @import("std");
const lexer = @import("lexer.zig");

/// An `export`ed declaration found in a token stream.
pub const Export = struct {
    name: []const u8,
    /// A static string from `DECL_KEYWORDS`, never a slice of the source.
    kind: []const u8,
    line: u32,
    /// True for `export function f` and for `export const f = () => {}` /
    /// `= async () => {}` / `= function () {}`. Only callable exports can be
    /// judged by "does anything call it"; a type or a constant is used by
    /// being named, not by being called.
    callable: bool,
};

/// A `catch` clause whose body contains no code.
pub const EmptyCatch = struct {
    line: u32,
};

const DECL_KEYWORDS = [_][]const u8{ "function", "const", "let", "var", "class", "type", "interface", "enum" };
const MODIFIERS = [_][]const u8{ "default", "async", "declare", "abstract" };

/// Enumerate `export function|const|class|type|interface|enum NAME` declarations.
///
/// Re-exports (`export { a } from ...`, `export * from ...`) are skipped: they
/// name something defined elsewhere, so they are never the orphan.
pub fn collectExports(alloc: std.mem.Allocator, lexed: lexer.Lexed) ![]Export {
    var out: std.ArrayList(Export) = .empty;
    errdefer out.deinit(alloc);

    const toks = lexed.tokens;
    var i: usize = 0;
    while (i < toks.len) : (i += 1) {
        if (!lexed.isIdent(toks[i], "export")) continue;

        var j = i + 1;
        while (j < toks.len and isAnyIdent(lexed, toks[j], &MODIFIERS)) j += 1;
        if (j >= toks.len or toks[j].kind != .ident) continue;

        var kind = staticKind(lexed.text(toks[j])) orelse continue;

        var k = j + 1;
        // `export const enum X` declares an enum, not a const.
        if (std.mem.eql(u8, kind, "const") and k < toks.len and lexed.isIdent(toks[k], "enum")) {
            kind = "enum";
            k += 1;
        }
        if (k >= toks.len or toks[k].kind != .ident) continue;

        try out.append(alloc, .{
            .name = lexed.text(toks[k]),
            .kind = kind,
            .line = lineOf(lexed.source, toks[k].start),
            .callable = isCallable(lexed, kind, k),
        });
    }
    return out.toOwnedSlice(alloc);
}

/// Find `catch` clauses with an empty body. A bare `catch {}` swallows the
/// error with no signal at all, which is the shape worth reviewing.
pub fn findEmptyCatches(alloc: std.mem.Allocator, lexed: lexer.Lexed) ![]EmptyCatch {
    var out: std.ArrayList(EmptyCatch) = .empty;
    errdefer out.deinit(alloc);

    const toks = lexed.tokens;
    var i: usize = 0;
    while (i < toks.len) : (i += 1) {
        if (!lexed.isIdent(toks[i], "catch")) continue;

        var j = i + 1;
        if (j < toks.len and lexed.isPunct(toks[j], '(')) {
            j = skipBalanced(lexed, j, '(', ')') orelse continue;
        }
        if (j >= toks.len or !lexed.isPunct(toks[j], '{')) continue;
        if (j + 1 >= toks.len or !lexed.isPunct(toks[j + 1], '}')) continue;

        try out.append(alloc, .{ .line = lineOf(lexed.source, toks[i].start) });
    }
    return out.toOwnedSlice(alloc);
}

/// Index of the token after the one closing the group opened at `open`.
pub fn skipBalanced(lexed: lexer.Lexed, open: usize, open_ch: u8, close_ch: u8) ?usize {
    var depth: usize = 0;
    var i = open;
    while (i < lexed.tokens.len) : (i += 1) {
        if (lexed.isPunct(lexed.tokens[i], open_ch)) depth += 1;
        if (lexed.isPunct(lexed.tokens[i], close_ch)) {
            depth -= 1;
            if (depth == 0) return i + 1;
        }
    }
    return null;
}

pub fn lineOf(source: []const u8, offset: u32) u32 {
    var line: u32 = 1;
    for (source[0..offset]) |c| {
        if (c == '\n') line += 1;
    }
    return line;
}

fn isAny(word: []const u8, set: []const []const u8) bool {
    for (set) |s| {
        if (std.mem.eql(u8, word, s)) return true;
    }
    return false;
}

/// Map a declaration keyword to the static entry in `DECL_KEYWORDS`, so the
/// returned slice never points into the file being scanned.
fn staticKind(word: []const u8) ?[]const u8 {
    for (DECL_KEYWORDS) |k| {
        if (std.mem.eql(u8, word, k)) return k;
    }
    return null;
}

fn isCallable(lexed: lexer.Lexed, kind: []const u8, name_index: usize) bool {
    if (std.mem.eql(u8, kind, "function")) return true;
    if (!std.mem.eql(u8, kind, "const") and !std.mem.eql(u8, kind, "let") and !std.mem.eql(u8, kind, "var")) {
        return false;
    }

    const toks = lexed.tokens;
    var m = name_index + 1;
    if (m >= toks.len or !lexed.isPunct(toks[m], '=')) return false;
    m += 1;
    if (m < toks.len and lexed.isIdent(toks[m], "async")) m += 1;
    if (m >= toks.len) return false;
    if (lexed.isPunct(toks[m], '(')) return true;
    if (lexed.isIdent(toks[m], "function")) return true;
    return false;
}

fn isAnyIdent(lexed: lexer.Lexed, token: lexer.Token, set: []const []const u8) bool {
    if (token.kind != .ident) return false;
    return isAny(lexed.text(token), set);
}

const testing = std.testing;

fn lexFor(alloc: std.mem.Allocator, src: []const u8) !lexer.Lexed {
    return lexer.lex(alloc, src);
}

test "collectExports finds the declaration forms that matter" {
    const alloc = testing.allocator;
    const src =
        \\export function alpha() {}
        \\export async function beta() {}
        \\export const gamma = 1;
        \\export class Delta {}
        \\export type Epsilon = string;
        \\export interface Zeta {}
        \\export const enum Eta { A }
        \\export { theta } from './x';
        \\export * from './y';
        \\const notExported = 1;
    ;
    const lexed = try lexFor(alloc, src);
    defer lexer.deinit(alloc, lexed);

    const exports = try collectExports(alloc, lexed);
    defer alloc.free(exports);

    const names = [_][]const u8{ "alpha", "beta", "gamma", "Delta", "Epsilon", "Zeta", "Eta" };
    try testing.expectEqual(names.len, exports.len);
    for (names, 0..) |expected, idx| {
        try testing.expectEqualStrings(expected, exports[idx].name);
    }
    try testing.expectEqualStrings("enum", exports[6].kind);
    try testing.expectEqual(@as(u32, 1), exports[0].line);
    try testing.expectEqual(@as(u32, 7), exports[6].line);
}

test "collectExports ignores names that only appear in comments or strings" {
    const alloc = testing.allocator;
    const src =
        \\// export function ghost() {}
        \\const s = "export const phantom = 1";
    ;
    const lexed = try lexFor(alloc, src);
    defer lexer.deinit(alloc, lexed);

    const exports = try collectExports(alloc, lexed);
    defer alloc.free(exports);
    try testing.expectEqual(@as(usize, 0), exports.len);
}

test "findEmptyCatches reports a bare catch and skips a handled one" {
    const alloc = testing.allocator;
    const src =
        \\try { a(); } catch {}
        \\try { b(); } catch (e) { log(e); }
        \\try { c(); } catch { }
        \\try { d(); } catch (e) {}
    ;
    const lexed = try lexFor(alloc, src);
    defer lexer.deinit(alloc, lexed);

    const found = try findEmptyCatches(alloc, lexed);
    defer alloc.free(found);

    try testing.expectEqual(@as(usize, 3), found.len);
    try testing.expectEqual(@as(u32, 1), found[0].line);
    try testing.expectEqual(@as(u32, 3), found[1].line);
    try testing.expectEqual(@as(u32, 4), found[2].line);
}

test "lineOf counts newlines before the offset" {
    try testing.expectEqual(@as(u32, 1), lineOf("abc", 0));
    try testing.expectEqual(@as(u32, 2), lineOf("a\nb", 2));
    try testing.expectEqual(@as(u32, 3), lineOf("a\nb\nc", 4));
}
