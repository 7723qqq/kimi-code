const std = @import("std");
const Io = std.Io;

const check = @import("../check.zig");
const fsutil = @import("../fsutil.zig");
const lexer = @import("../lexer.zig");
const paths = @import("../paths.zig");
const ts_scan = @import("../ts_scan.zig");
const walk = @import("../walk.zig");

/// `catch {}` with nothing in it. Many of these are deliberate best-effort
/// cleanup, which is why the check carries a per-file baseline: the point is
/// to make each one a decision someone made, not an accident.
///
/// The baseline counts per file rather than naming lines, so ordinary edits
/// above a catch do not churn the ledger, while a new swallow still pushes the
/// count past what was accepted and fails the run.
const BASELINE_PATH = "tools/review/silent-catch-baseline.txt";

pub fn run(ctx: *check.Context) !void {
    const files = try walk.collectFiles(ctx.alloc, ctx.io, ctx.root_dir, .{
        .skip_dirs = &paths.SKIP_DIRS,
        .suffixes = &.{ ".ts", ".tsx", ".vue", ".js", ".mjs" },
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

        const found = try ts_scan.findEmptyCatches(ctx.alloc, lexed);
        defer ctx.alloc.free(found);
        if (found.len == 0) continue;

        const count: u32 = @intCast(found.len);
        const allowed = if (baseline.get(rel)) |value|
            std.fmt.parseInt(u32, value, 10) catch 0
        else
            0;

        if (count <= allowed) {
            if (count < allowed) {
                try ctx.report.add(.{
                    .check = "silent-catch",
                    .severity = .info,
                    .file = try ctx.alloc.dupe(u8, rel),
                    .message = try std.fmt.allocPrint(
                        ctx.alloc,
                        "baseline allows {d} empty catch block(s), found {d}; tighten it",
                        .{ allowed, count },
                    ),
                    .evidence = try std.fmt.allocPrint(ctx.alloc, "edit {s}", .{BASELINE_PATH}),
                });
            }
            continue;
        }

        try ctx.report.add(.{
            .check = "silent-catch",
            .severity = .err,
            .file = try ctx.alloc.dupe(u8, rel),
            .message = try std.fmt.allocPrint(
                ctx.alloc,
                "{d} empty catch block(s), baseline allows {d}",
                .{ count, allowed },
            ),
            .evidence = try std.fmt.allocPrint(
                ctx.alloc,
                "lines {s}; raise the count in {s} if swallowing is deliberate",
                .{ try lineList(ctx.alloc, found), BASELINE_PATH },
            ),
        });
    }

    try baseline.reportStale(ctx, "silent-catch", BASELINE_PATH);
}

/// "12,45,78" — the lines a file's empty catches sit on, for the evidence line.
fn lineList(alloc: std.mem.Allocator, found: []const ts_scan.EmptyCatch) ![]const u8 {
    const buf = try alloc.alloc(u8, found.len * 12);
    errdefer alloc.free(buf);
    var n: usize = 0;
    for (found, 0..) |hit, i| {
        if (i > 0) {
            buf[n] = ',';
            n += 1;
        }
        const written = try std.fmt.bufPrint(buf[n..], "{d}", .{hit.line});
        n += written.len;
    }
    // The caller frees what it is handed, and a slice cannot be freed against a
    // larger allocation, so shrink to the bytes actually written.
    return try alloc.realloc(buf, n);
}

/// Unlike the other lexer checks this one reads test files too: a bare
/// `catch {}` swallows an error wherever it sits. `paths` keeps that
/// difference named rather than left to a copy of the predicate.
const isSource = paths.isSrcSourceIncludingTests;

const testing = std.testing;

test "isSource keeps package and app sources and drops declarations" {
    try testing.expect(isSource("packages/kosong/src/index.ts"));
    try testing.expect(isSource("apps/kimi-code/src/main.ts"));
    try testing.expect(isSource("apps/kimi-web/src/App.vue"));
    try testing.expect(!isSource("packages/kosong/src/types.d.ts"));
    try testing.expect(!isSource("scripts/thing.ts"));
}

test "lineList joins the lines of every empty catch" {
    const alloc = testing.allocator;
    const found = [_]ts_scan.EmptyCatch{ .{ .line = 12 }, .{ .line = 45 }, .{ .line = 7 } };
    const list = try lineList(alloc, &found);
    defer alloc.free(list);
    try testing.expectEqualStrings("12,45,7", list);
}
