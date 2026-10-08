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

/// The ref this check diffs against. A fork that never fetched `upstream`
/// cannot answer the question at all, which is reported rather than passed.
const UPSTREAM_REF = "upstream/main";

pub fn run(ctx: *check.Context) !void {
    const diff = proc.run(ctx.alloc, ctx.io, ctx.root_dir, &.{
        "git", "diff", "--diff-filter=D", "--name-only", UPSTREAM_REF, "HEAD",
    }) catch |e| {
        try reportSkipped(ctx, "git could not be run", @errorName(e));
        return;
    };
    defer diff.deinit(ctx.alloc);

    // No upstream remote (a plain clone, or CI whose checkout carries only the
    // fork): there is nothing to compare against. Reported, because an unrun
    // check that exits silently is indistinguishable from a passing one — and
    // this is exactly how a dropped file reaches `main` unnoticed.
    if (!diff.ok()) {
        const detail = std.mem.trim(u8, diff.stderr, " \t\r\n");
        try reportSkipped(
            ctx,
            "the upstream ref is unavailable, so no dropped file could be detected",
            if (detail.len > 0) detail else "git diff exited non-zero with no message",
        );
        return;
    }

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

/// The check could not run, so it says so instead of returning quietly.
///
/// `info` rather than `err`: a clone without the upstream remote is a normal
/// state, and failing CI over it would be wrong. But the run must not look
/// clean either — the whole point is that an unrun gate is not a passed gate.
fn reportSkipped(ctx: *check.Context, message: []const u8, detail: []const u8) !void {
    try ctx.report.add(.{
        .check = "upstream-drift",
        .severity = .info,
        .file = ".git",
        .message = message,
        .evidence = try std.fmt.allocPrint(
            ctx.alloc,
            "{s}; to enable this check run `git remote add upstream https://github.com/MoonshotAI/kimi-code.git && git fetch upstream`",
            .{detail},
        ),
    });
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
