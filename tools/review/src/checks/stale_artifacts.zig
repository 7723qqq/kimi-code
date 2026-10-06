const std = @import("std");
const Io = std.Io;

const check = @import("../check.zig");
const proc = @import("../proc.zig");

/// A generated artifact that has a generator but no freshness gate drifts
/// silently: the source changes, the committed output does not, and nothing
/// notices until someone reads the stale file.
const Generator = struct {
    label: []const u8,
    argv: []const []const u8,
    /// Substring that identifies the generated files in `git status` output.
    marker: []const u8,
};

const GENERATORS = [_]Generator{
    .{
        .label = "locale JSON",
        .argv = &.{ "bun", "scripts/generate-locale-json.cjs" },
        .marker = "/locales/",
    },
};

pub fn run(ctx: *check.Context) !void {
    for (GENERATORS) |gen| {
        // Snapshot before and after so only the files this generator actually
        // rewrote are reported. Comparing against HEAD instead would flag
        // every uncommitted edit the developer happens to have in the tree.
        const before = try snapshot(ctx);
        defer before.deinit(ctx.alloc);

        const out = proc.run(ctx.alloc, ctx.io, ctx.root_dir, gen.argv) catch {
            try ctx.report.add(.{
                .check = "stale-artifacts",
                .severity = .info,
                .file = gen.argv[1],
                .message = try std.fmt.allocPrint(
                    ctx.alloc,
                    "could not run the {s} generator; freshness not verified",
                    .{gen.label},
                ),
                .evidence = "the generator command could not be started",
            });
            continue;
        };
        defer out.deinit(ctx.alloc);

        if (!out.ok()) {
            try ctx.report.add(.{
                .check = "stale-artifacts",
                .severity = .err,
                .file = gen.argv[1],
                .message = try std.fmt.allocPrint(
                    ctx.alloc,
                    "the {s} generator failed, so its output cannot be trusted",
                    .{gen.label},
                ),
                .evidence = try std.fmt.allocPrint(ctx.alloc, "exit code {d}", .{out.exit_code}),
            });
            continue;
        }

        const after = try snapshot(ctx);
        defer after.deinit(ctx.alloc);

        var lines = std.mem.splitScalar(u8, after.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, gen.marker) == null) continue;
            const path = pathOf(line) orelse continue;
            if (!std.mem.endsWith(u8, path, ".json")) continue;
            if (containsPath(before.stdout, path)) continue;

            try ctx.report.add(.{
                .check = "stale-artifacts",
                .severity = .err,
                .file = try ctx.alloc.dupe(u8, path),
                .message = try std.fmt.allocPrint(
                    ctx.alloc,
                    "generated {s} is out of date with its source",
                    .{gen.label},
                ),
                .evidence = try std.fmt.allocPrint(
                    ctx.alloc,
                    "regenerating with `{s}` rewrote it",
                    .{try std.mem.join(ctx.alloc, " ", gen.argv)},
                ),
            });
        }
    }
}

fn snapshot(ctx: *check.Context) !proc.Output {
    return proc.run(ctx.alloc, ctx.io, ctx.root_dir, &.{ "git", "status", "--porcelain" });
}

/// The path field of a `git status --porcelain` line: two status characters, a
/// space, then the path. The status may itself begin with a space (` M` for a
/// worktree modification), so leading whitespace must not be trimmed — doing so
/// shifts the path and every comparison silently misses.
fn pathOf(line: []const u8) ?[]const u8 {
    const trimmed = std.mem.trimEnd(u8, line, "\r");
    if (trimmed.len < 4) return null;
    return trimmed[3..];
}

fn containsPath(status: []const u8, path: []const u8) bool {
    var lines = std.mem.splitScalar(u8, status, '\n');
    while (lines.next()) |line| {
        const candidate = pathOf(line) orelse continue;
        if (std.mem.eql(u8, candidate, path)) return true;
    }
    return false;
}

const testing = std.testing;

test "containsPath finds a path already dirty before the generator ran" {
    const status =
        \\ M apps/kimi-code/src/i18n/locales/en.json
        \\?? tools/review/zig-out/
        \\ M packages/kosong/src/errors.ts
    ;
    try testing.expect(containsPath(status, "apps/kimi-code/src/i18n/locales/en.json"));
    try testing.expect(containsPath(status, "packages/kosong/src/errors.ts"));
    try testing.expect(!containsPath(status, "apps/kimi-code/src/i18n/locales/zh.json"));
}

test "containsPath ignores blank and short lines" {
    try testing.expect(!containsPath("\n\n \n", "anything"));
}

test "pathOf keeps the path intact when the status starts with a space" {
    try testing.expectEqualStrings(
        "apps/kimi-code/src/i18n/locales/en.json",
        pathOf(" M apps/kimi-code/src/i18n/locales/en.json").?,
    );
    try testing.expectEqualStrings("tools/review/zig-out/", pathOf("?? tools/review/zig-out/").?);
    try testing.expectEqualStrings("a.ts", pathOf(" M a.ts\r").?);
    try testing.expect(pathOf(" M ") == null);
    try testing.expect(pathOf("") == null);
}
