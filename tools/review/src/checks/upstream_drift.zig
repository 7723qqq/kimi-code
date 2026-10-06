const std = @import("std");
const Io = std.Io;

const check = @import("../check.zig");
const fsutil = @import("../fsutil.zig");
const proc = @import("../proc.zig");

/// Files the fork deliberately does not carry, one path per line. Anything
/// deleted relative to upstream that is not listed here is reported, so an
/// accidental drop during a merge shows up instead of blending into the
/// intentional ones.
const ALLOWLIST_PATH = "tools/review/upstream-drift-allow.txt";

pub fn run(ctx: *check.Context) !void {
    const diff = proc.run(ctx.alloc, ctx.io, ctx.root_dir, &.{
        "git", "diff", "--diff-filter=D", "--name-only", "upstream/main", "HEAD",
    }) catch return;
    defer diff.deinit(ctx.alloc);

    // No upstream remote (a plain clone, or CI): nothing to compare against.
    if (!diff.ok()) return;

    const allow = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, ALLOWLIST_PATH) orelse "";
    defer if (allow.len > 0) ctx.alloc.free(allow);

    var lines = std.mem.splitScalar(u8, diff.stdout, '\n');
    while (lines.next()) |raw| {
        const path = std.mem.trim(u8, raw, " \r");
        if (path.len == 0) continue;
        if (isAllowed(allow, path)) continue;

        try ctx.report.add(.{
            .check = "upstream-drift",
            .severity = .warn,
            .file = try ctx.alloc.dupe(u8, path),
            .message = "upstream carries this file but this branch does not",
            .evidence = try std.fmt.allocPrint(
                ctx.alloc,
                "add it to {s} if the removal is intentional",
                .{ALLOWLIST_PATH},
            ),
        });
    }
}

fn isAllowed(allow: []const u8, path: []const u8) bool {
    var lines = std.mem.splitScalar(u8, allow, '\n');
    while (lines.next()) |raw| {
        const entry = std.mem.trim(u8, raw, " \r\t");
        if (entry.len == 0 or entry[0] == '#') continue;
        if (std.mem.eql(u8, entry, path)) return true;
    }
    return false;
}

const testing = std.testing;

test "isAllowed matches whole paths and skips comments and blanks" {
    const allow =
        \\# retired with the pnpm toolchain
        \\.npmrc
        \\pnpm-lock.yaml
        \\
        \\AGENTS.md
    ;
    try testing.expect(isAllowed(allow, ".npmrc"));
    try testing.expect(isAllowed(allow, "pnpm-lock.yaml"));
    try testing.expect(isAllowed(allow, "AGENTS.md"));
    try testing.expect(!isAllowed(allow, "packages/kosong/src/index.ts"));
    try testing.expect(!isAllowed(allow, "# retired with the pnpm toolchain"));
    try testing.expect(!isAllowed(allow, "npmrc"));
}
