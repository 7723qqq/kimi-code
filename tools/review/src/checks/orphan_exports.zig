const std = @import("std");
const Io = std.Io;

const check = @import("../check.zig");
const fsutil = @import("../fsutil.zig");
const lexer = @import("../lexer.zig");
const paths = @import("../paths.zig");
const ts_scan = @import("../ts_scan.zig");
const walk = @import("../walk.zig");

/// Exported functions that production code never references but a test does.
///
/// This is the shape of code kept alive only by its own test: the test passes,
/// so nothing looks wrong, while the shipped bundle carries a function no
/// caller reaches. A function referenced nowhere at all is a different (and
/// much noisier) question, and a function referenced by production code is
/// simply in use.
const BASELINE_PATH = "tools/review/orphan-exports-baseline.txt";

const ExportRec = struct {
    name: []const u8,
    file: []const u8,
    kind: []const u8,
    line: u32,
    callable: bool,
    /// How many times the name appears in its own file, declaration included.
    own_total: u32,
    /// How many of those are the `export` declaration itself. The rest are
    /// real references from the same file, and a function its own module calls
    /// is in use, not an orphan.
    own_decls: u32,
};

pub fn run(ctx: *check.Context) !void {
    const files = try walk.collectFiles(ctx.alloc, ctx.io, ctx.root_dir, .{
        .skip_dirs = &paths.SKIP_DIRS,
        .suffixes = &.{ ".ts", ".tsx", ".vue", ".js", ".mjs" },
    });
    defer walk.freeFiles(ctx.alloc, files);

    var prod: std.StringHashMap(u32) = .init(ctx.alloc);
    defer freeMap(ctx.alloc, &prod);
    var test_refs: std.StringHashMap(u32) = .init(ctx.alloc);
    defer freeMap(ctx.alloc, &test_refs);

    var exports: std.ArrayList(ExportRec) = .empty;
    defer exports.deinit(ctx.alloc);

    for (files) |rel| {
        if (!isTypeScriptSource(rel)) continue;

        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, rel) orelse continue;
        defer ctx.alloc.free(text);

        const lexed = lexer.lex(ctx.alloc, text) catch continue;
        defer lexer.deinit(ctx.alloc, lexed);
        // A file the lexer could not resolve is skipped rather than guessed at.
        if (!lexed.reliable) continue;

        const is_test = isTestSource(rel);
        if (is_test) {
            try countIdentifiers(ctx.alloc, lexed, &test_refs);
            continue;
        }
        if (!isProductionSource(rel)) continue;

        var local: std.StringHashMap(u32) = .init(ctx.alloc);
        defer freeMap(ctx.alloc, &local);
        try countIdentifiers(ctx.alloc, lexed, &local);

        var it = local.iterator();
        while (it.next()) |entry| {
            const gop = try prod.getOrPut(entry.key_ptr.*);
            if (!gop.found_existing) {
                gop.key_ptr.* = try ctx.alloc.dupe(u8, entry.key_ptr.*);
                gop.value_ptr.* = 0;
            }
            gop.value_ptr.* += entry.value_ptr.*;
        }

        const found = try ts_scan.collectExports(ctx.alloc, lexed);
        defer ctx.alloc.free(found);

        // A name declared twice in one file (an overload pair, say) must not
        // have its second declaration counted as a use.
        var decls: std.StringHashMap(u32) = .init(ctx.alloc);
        defer decls.deinit();
        for (found) |e| {
            const gop = try decls.getOrPut(e.name);
            if (!gop.found_existing) gop.value_ptr.* = 0;
            gop.value_ptr.* += 1;
        }

        for (found) |e| {
            try exports.append(ctx.alloc, .{
                .name = try ctx.alloc.dupe(u8, e.name),
                .file = try ctx.alloc.dupe(u8, rel),
                .kind = e.kind,
                .line = e.line,
                .callable = e.callable,
                .own_total = local.get(e.name) orelse 0,
                .own_decls = decls.get(e.name) orelse 1,
            });
        }
    }

    var baseline = try check.Baseline.load(ctx.alloc, ctx.io, ctx.root_dir, BASELINE_PATH);
    defer baseline.deinit();

    for (exports.items) |e| {
        // Only callable exports can be judged this way: a type or a constant
        // is used by being named, and naming it is already counted.
        if (!e.callable) continue;
        if (baseline.get(e.name) != null) continue;
        // Production code outside the defining file must not mention it...
        const prod_total = prod.get(e.name) orelse 0;
        if (prod_total -| e.own_total > 0) continue;
        // ...nor may the defining file itself call it...
        if (e.own_total -| e.own_decls > 0) continue;
        // ...while a test must, or it is simply unreferenced everywhere.
        if ((test_refs.get(e.name) orelse 0) == 0) continue;

        try ctx.report.add(.{
            .check = "orphan-exports",
            .severity = .err,
            .file = e.file,
            .line = e.line,
            .message = try std.fmt.allocPrint(
                ctx.alloc,
                "exported {s} '{s}' is referenced only by its own test, never by production code",
                .{ e.kind, e.name },
            ),
            .evidence = try std.fmt.allocPrint(
                ctx.alloc,
                "add `{s}  {s}` to {s} if it is public API surface",
                .{ e.name, e.file, BASELINE_PATH },
            ),
        });
    }

    try baseline.reportStale(ctx, "orphan-exports", BASELINE_PATH);
}

fn freeMap(alloc: std.mem.Allocator, map: *std.StringHashMap(u32)) void {
    var it = map.keyIterator();
    while (it.next()) |k| alloc.free(k.*);
    map.deinit();
}

/// Every TypeScript file in a package or app, tests included. Narrowing this
/// to `/src/` would drop the package-root `test/` directories — `kosong/test`,
/// `klient/test` and friends — and with them every reference the tests make,
/// which is the whole signal this check runs on.
const isTypeScriptSource = paths.isTypeScriptSource;

const isTestSource = paths.isTestSource;

/// Only `src/` TypeScript counts, and tests never count: a symbol its own test
/// calls is still unused by the product.
const isProductionSource = paths.isProductionSource;

fn countIdentifiers(
    alloc: std.mem.Allocator,
    lexed: lexer.Lexed,
    into: *std.StringHashMap(u32),
) !void {
    for (lexed.tokens) |token| {
        if (token.kind != .ident) continue;
        const name = lexed.text(token);
        const gop = try into.getOrPut(name);
        if (!gop.found_existing) {
            gop.key_ptr.* = try alloc.dupe(u8, name);
            gop.value_ptr.* = 0;
        }
        gop.value_ptr.* += 1;
    }
}

const testing = std.testing;

test "isProductionSource keeps src TypeScript and drops tests and declarations" {
    try testing.expect(isProductionSource("packages/kosong/src/index.ts"));
    try testing.expect(isProductionSource("apps/kimi-code/src/main.tsx"));

    try testing.expect(!isProductionSource("packages/kosong/test/foo.ts"));
    try testing.expect(!isProductionSource("packages/kosong/src/foo.test.ts"));
    try testing.expect(!isProductionSource("packages/kosong/src/foo.spec.ts"));
    try testing.expect(!isProductionSource("packages/kosong/src/types.d.ts"));
    try testing.expect(!isProductionSource("scripts/thing.ts"));
    try testing.expect(!isProductionSource("packages/kosong/README.md"));
}

test "countIdentifiers counts every mention, not just calls" {
    const alloc = testing.allocator;
    const src =
        \\function declared() {}
        \\const a = declared();
        \\const ref = declared;
        \\export { declared };
    ;
    const lexed = try lexer.lex(alloc, src);
    defer lexer.deinit(alloc, lexed);

    var map: std.StringHashMap(u32) = .init(alloc);
    defer {
        var it = map.keyIterator();
        while (it.next()) |k| alloc.free(k.*);
        map.deinit();
    }
    try countIdentifiers(alloc, lexed, &map);

    // declaration + call + bare reference + re-export
    try testing.expectEqual(@as(u32, 4), map.get("declared").?);
}

