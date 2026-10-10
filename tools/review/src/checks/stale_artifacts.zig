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
    /// Working directory relative to the repository root. Empty means the root
    /// itself; `bun run` scripts resolve relative to their own package, so a
    /// generator that lives in a package must be run from that package.
    cwd: []const u8 = "",
    /// Substring that identifies the generated files in `git status` output.
    /// Each generator must claim a distinct path fragment: a marker that
    /// matches another generator's output would report the same file twice.
    marker: []const u8,
};

/// Every committed artifact with a generator. A generator whose output is
/// tracked but never regenerated in CI is how a source change ships beside a
/// stale manifest.
const GENERATORS = [_]Generator{
    .{
        .label = "config manifest",
        .argv = &.{ "bun", "scripts/gen-config-manifest.mts" },
        .cwd = "packages/agent-core-v2",
        .marker = "/docs/config-manifest.toml",
    },
    .{
        .label = "wire manifest",
        .argv = &.{ "bun", "scripts/gen-wire-manifest.mts" },
        .cwd = "packages/agent-core-v2",
        .marker = "/docs/wire-manifest.d.ts",
    },
    .{
        .label = "state manifest",
        .argv = &.{ "bun", "scripts/gen-state-manifest.mts" },
        .cwd = "packages/agent-core-v2",
        .marker = "/docs/state-manifest.d.ts",
    },
};

pub fn run(ctx: *check.Context) !void {
    for (GENERATORS) |gen| {
        // Snapshot before and after so only the files this generator actually
        // rewrote are reported. Comparing against HEAD instead would flag
        // every uncommitted edit the developer happens to have in the tree.
        //
        // A snapshot needs a git repository. Without one the diff cannot be
        // drawn and the generator must not run at all: rewriting artifacts in
        // an untracked tree could not be detected, so "no drift" would be a
        // claim this check has no evidence for.
        const before = snapshot(ctx) catch |e| {
            try reportUnusableTree(ctx, gen, @errorName(e));
            return;
        };
        defer before.deinit(ctx.alloc);

        if (!before.ok()) {
            try reportUnusableTree(ctx, gen, "git status failed");
            return;
        }

        const cwd = try generatorDir(ctx, gen);
        defer if (gen.cwd.len > 0) Io.Dir.close(cwd, ctx.io);

        const out = proc.run(ctx.alloc, ctx.io, cwd, gen.argv) catch {
            try ctx.report.add(.{
                .check = "stale-artifacts",
                .severity = .info,
                .file = try ctx.alloc.dupe(u8, gen.argv[1]),
                .message = try std.fmt.allocPrint(
                    ctx.alloc,
                    "could not run the {s} generator, so its output was not checked for freshness",
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

        const after = snapshot(ctx) catch |e| {
            try reportUnusableTree(ctx, gen, @errorName(e));
            return;
        };
        defer after.deinit(ctx.alloc);

        var lines = std.mem.splitScalar(u8, after.stdout, '\n');
        while (lines.next()) |line| {
            // The marker names the artifact's exact path, so it is the filter.
            // An extension check here would silently drop every non-`.json`
            // output, which is how a stale `.toml` or `.d.ts` would slip past.
            if (std.mem.indexOf(u8, line, gen.marker) == null) continue;
            const path = pathOf(line) orelse continue;
            if (!std.mem.endsWith(u8, path, gen.marker)) continue;
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

/// The directory a generator runs in: the repository root, or the package the
/// generator's script belongs to.
fn generatorDir(ctx: *check.Context, gen: Generator) !Io.Dir {
    if (gen.cwd.len == 0) return ctx.root_dir;
    return Io.Dir.openDir(ctx.root_dir, ctx.io, gen.cwd, .{});
}

/// The tree cannot be diffed with `git status`, so freshness cannot be judged.
/// Reported once and the check stops: without a snapshot every generator would
/// re-report the same condition.
fn reportUnusableTree(ctx: *check.Context, gen: Generator, detail: []const u8) !void {
    try ctx.report.add(.{
        .check = "stale-artifacts",
        .severity = .info,
        .file = try ctx.alloc.dupe(u8, gen.argv[1]),
        .message = "the working tree is not a git repository, so no generated artifact was checked",
        .evidence = try std.fmt.allocPrint(
            ctx.alloc,
            "git status is how a rewritten artifact is detected ({s}); run this check inside the checkout",
            .{detail},
        ),
    });
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
        \\ M packages/agent-core-v2/docs/state-manifest.d.ts
        \\?? tools/review/zig-out/
        \\ M packages/kosong/src/errors.ts
    ;
    try testing.expect(containsPath(status, "packages/agent-core-v2/docs/state-manifest.d.ts"));
    try testing.expect(containsPath(status, "packages/kosong/src/errors.ts"));
    try testing.expect(!containsPath(status, "packages/agent-core-v2/docs/wire-manifest.d.ts"));
}

test "containsPath ignores blank and short lines" {
    try testing.expect(!containsPath("\n\n \n", "anything"));
}

test "pathOf keeps the path intact when the status starts with a space" {
    try testing.expectEqualStrings(
        "packages/agent-core-v2/docs/state-manifest.d.ts",
        pathOf(" M packages/agent-core-v2/docs/state-manifest.d.ts").?,
    );
    try testing.expectEqualStrings("tools/review/zig-out/", pathOf("?? tools/review/zig-out/").?);
    try testing.expectEqualStrings("a.ts", pathOf(" M a.ts\r").?);
    try testing.expect(pathOf(" M ") == null);
    try testing.expect(pathOf("") == null);
}
