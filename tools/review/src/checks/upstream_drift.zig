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
    // Probed separately from the drift set so a missing upstream remote still
    // reports the command that fixes it rather than a bare error name.
    const base = proc.run(ctx.alloc, ctx.io, ctx.root_dir, &.{
        "git", "merge-base", UPSTREAM_REF, "HEAD",
    }) catch |e| {
        try reportSkipped(ctx, "git could not be run", @errorName(e));
        return;
    };
    defer base.deinit(ctx.alloc);

    if (!base.ok()) {
        try reportSkipped(
            ctx,
            "the upstream ref is unavailable, so no dropped file could be detected",
            "run `git fetch upstream main` (the check needs a common ancestor with HEAD)",
        );
        return;
    }

    const allow = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, ALLOWLIST_PATH) orelse "";
    defer if (allow.len > 0) ctx.alloc.free(allow);

    const drift = driftAgainstUpstream(ctx.alloc, ctx.io, ctx.root_dir, UPSTREAM_REF) catch |e| switch (e) {
        error.NoMergeBase => {
            try reportSkipped(ctx, "no merge base with upstream", "unrelated histories");
            return;
        },
        error.DiffFailed => {
            try reportSkipped(
                ctx,
                "git diff against the merge base failed, so no dropped file could be detected",
                "git diff exited non-zero with no message",
            );
            return;
        },
        else => {
            try reportSkipped(ctx, "git could not be run", @errorName(e));
            return;
        },
    };
    defer freeDeletions(ctx.alloc, drift);

    for (drift) |path| {
        if (isAllowed(allow, path)) continue;

        try ctx.report.add(.{
            .check = "upstream-drift",
            .severity = .err,
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

/// The paths this branch dropped since the merge base that upstream still
/// carries — the check's question apart from the allowlist.
///
/// The base is the merge base, not the upstream tip: `git diff <upstream-tip>
/// HEAD` cannot tell "we deleted it" from "upstream added it after the fork",
/// so every upstream addition would read as a deletion on this branch.
///
/// That diff still answers only half the question, though. "Upstream carries
/// this file but this branch does not" is two-sided, and a path upstream moved
/// is a rename there and a deletion here, so comparing deletion sets would call
/// a moved test drift; the release workflow also consumes each `.changeset/`
/// file on whichever branch releases it, so those deletions match on both lines
/// and would drown the ones that matter.
///
/// The first half is asked directly instead: the paths present upstream and
/// absent here are exactly `--diff-filter=A` from HEAD to the upstream ref.
/// Intersecting the two drops the shared removals and the moves without a
/// per-path `cat-file`.
fn driftAgainstUpstream(
    alloc: std.mem.Allocator,
    io: Io,
    cwd: Io.Dir,
    upstream_ref: []const u8,
) ![]const []const u8 {
    const base = try proc.run(alloc, io, cwd, &.{ "git", "merge-base", upstream_ref, "HEAD" });
    defer alloc.free(base.stdout);
    defer alloc.free(base.stderr);
    if (base.exit_code != 0) return error.NoMergeBase;

    const merge_base = std.mem.trim(u8, base.stdout, " \t\r\n");
    if (merge_base.len == 0) return error.NoMergeBase;

    const dropped = try proc.run(
        alloc,
        io,
        cwd,
        &.{ "git", "diff", "--diff-filter=D", "--name-only", merge_base, "HEAD" },
    );
    defer alloc.free(dropped.stdout);
    defer alloc.free(dropped.stderr);
    if (dropped.exit_code != 0) return error.DiffFailed;

    const upstream_has = try proc.run(
        alloc,
        io,
        cwd,
        &.{ "git", "diff", "--diff-filter=A", "--name-only", "HEAD", upstream_ref },
    );
    defer alloc.free(upstream_has.stdout);
    defer alloc.free(upstream_has.stderr);
    if (upstream_has.exit_code != 0) return error.DiffFailed;

    var out: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (out.items) |item| alloc.free(item);
        out.deinit(alloc);
    }
    var lines = std.mem.splitScalar(u8, dropped.stdout, '\n');
    while (lines.next()) |raw| {
        const path = std.mem.trim(u8, raw, " \r");
        if (path.len == 0) continue;
        if (!isPresent(upstream_has.stdout, path)) continue;
        try out.append(alloc, try alloc.dupe(u8, path));
    }
    return out.toOwnedSlice(alloc);
}

/// Whether `path` appears as a whole line in a newline-separated listing.
fn isPresent(listing: []const u8, path: []const u8) bool {
    var lines = std.mem.splitScalar(u8, listing, '\n');
    while (lines.next()) |raw| {
        const candidate = std.mem.trim(u8, raw, " \r");
        if (candidate.len == 0) continue;
        if (std.mem.eql(u8, candidate, path)) return true;
    }
    return false;
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

/// The comparison basis, exercised against a real git repository built in a
/// temp dir. This is the exact shape of the bug this file shipped with once:
/// `git diff <upstream-tip> HEAD` cannot tell "we deleted it" from "upstream
/// added it after the fork", so the base has to be the merge base.
///
/// Returns the relative paths `git diff --diff-filter=D <base> HEAD` reports,
/// where `base` follows the same rule `run` uses.
fn deletionsAgainstMergeBase(
    alloc: std.mem.Allocator,
    io: Io,
    cwd: Io.Dir,
    upstream_ref: []const u8,
) ![]const []const u8 {
    const base = try proc.run(alloc, io, cwd, &.{ "git", "merge-base", upstream_ref, "HEAD" });
    defer alloc.free(base.stdout);
    defer alloc.free(base.stderr);
    if (base.exit_code != 0) return error.NoMergeBase;

    const merge_base = std.mem.trim(u8, base.stdout, " \t\r\n");
    const diff = try proc.run(
        alloc,
        io,
        cwd,
        &.{ "git", "diff", "--diff-filter=D", "--name-only", merge_base, "HEAD" },
    );
    defer alloc.free(diff.stderr);
    if (diff.exit_code != 0) {
        alloc.free(diff.stdout);
        return error.DiffFailed;
    }

    var out: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (out.items) |item| alloc.free(item);
        out.deinit(alloc);
        alloc.free(diff.stdout);
    }
    var lines = std.mem.splitScalar(u8, diff.stdout, '\n');
    while (lines.next()) |raw| {
        const path = std.mem.trim(u8, raw, " \r");
        if (path.len == 0) continue;
        try out.append(alloc, try alloc.dupe(u8, path));
    }
    alloc.free(diff.stdout);
    return out.toOwnedSlice(alloc);
}

fn freeDeletions(alloc: std.mem.Allocator, paths: []const []const u8) void {
    for (paths) |path| alloc.free(path);
    alloc.free(paths);
}

/// `git init` + a commit, with the identity baked into the repo so the test
/// does not depend on the machine's git config.
fn gitSetup(alloc: std.mem.Allocator, io: Io, dir: Io.Dir) !void {
    const steps = [_][]const []const u8{
        &.{ "git", "init", "-q", "-b", "main" },
        &.{ "git", "config", "user.email", "t@example.invalid" },
        &.{ "git", "config", "user.name", "t" },
    };
    for (steps) |argv| {
        const out = try proc.run(alloc, io, dir, argv);
        defer alloc.free(out.stdout);
        defer alloc.free(out.stderr);
        if (out.exit_code != 0) return error.GitFailed;
    }
}

fn gitCommitAll(alloc: std.mem.Allocator, io: Io, dir: Io.Dir, message: []const u8) !void {
    const add = try proc.run(alloc, io, dir, &.{ "git", "add", "-A" });
    defer alloc.free(add.stdout);
    defer alloc.free(add.stderr);
    if (add.exit_code != 0) return error.GitFailed;

    const commit = try proc.run(alloc, io, dir, &.{ "git", "commit", "-qm", message });
    defer alloc.free(commit.stdout);
    defer alloc.free(commit.stderr);
    if (commit.exit_code != 0) return error.GitFailed;
}

fn writeFileAt(io: Io, dir: Io.Dir, path: []const u8, contents: []const u8) !void {
    try Io.Dir.writeFile(dir, io, .{ .sub_path = path, .data = contents });
}

test "a file upstream ADDED after the fork is not reported as our deletion" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const alloc = testing.allocator;
    const io = testing.io;

    try gitSetup(alloc, io, tmp.dir);

    // Commit 1: the shared fork point.
    try writeFileAt(io, tmp.dir, "shared.txt", "shared\n");
    try gitCommitAll(alloc, io, tmp.dir, "fork point");

    // Commit 2: this branch does work and deletes nothing.
    try writeFileAt(io, tmp.dir, "ours.txt", "our work\n");
    try gitCommitAll(alloc, io, tmp.dir, "our change");
    const fork_tip = try proc.run(alloc, io, tmp.dir, &.{ "git", "rev-parse", "HEAD" });
    defer alloc.free(fork_tip.stdout);
    defer alloc.free(fork_tip.stderr);

    // Commit 3: upstream moves on independently and adds a brand-new file.
    const checkout_main = try proc.run(alloc, io, tmp.dir, &.{ "git", "checkout", "-q", "-b", "upstream-line", "main" });
    defer alloc.free(checkout_main.stdout);
    defer alloc.free(checkout_main.stderr);
    try writeFileAt(io, tmp.dir, "upstream-new.txt", "brand new upstream file\n");
    try gitCommitAll(alloc, io, tmp.dir, "upstream moves on");

    // Point `upstream/main` at the advanced commit, then come back to ours.
    const set_ref = try proc.run(alloc, io, tmp.dir, &.{ "git", "update-ref", "refs/remotes/upstream/main", "HEAD" });
    defer alloc.free(set_ref.stdout);
    defer alloc.free(set_ref.stderr);
    const back = try proc.run(alloc, io, tmp.dir, &.{ "git", "checkout", "-q", "main" });
    defer alloc.free(back.stdout);
    defer alloc.free(back.stderr);

    // The old, wrong basis: the upstream TIP. It reports upstream's own new
    // file, which this branch never touched.
    const tip_diff = try proc.run(
        alloc,
        io,
        tmp.dir,
        &.{ "git", "diff", "--diff-filter=D", "--name-only", "refs/remotes/upstream/main", "HEAD" },
    );
    defer alloc.free(tip_diff.stdout);
    defer alloc.free(tip_diff.stderr);
    try testing.expectEqualStrings("upstream-new.txt\n", tip_diff.stdout);

    // The fix: the merge base. Nothing was deleted on this branch.
    const deletions = try deletionsAgainstMergeBase(alloc, io, tmp.dir, "refs/remotes/upstream/main");
    defer freeDeletions(alloc, deletions);
    try testing.expectEqual(@as(usize, 0), deletions.len);
}

test "a file this branch deleted IS reported, so the fix does not go blind" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const alloc = testing.allocator;
    const io = testing.io;

    try gitSetup(alloc, io, tmp.dir);

    try writeFileAt(io, tmp.dir, "keep.txt", "keep\n");
    try writeFileAt(io, tmp.dir, "doomed.txt", "delete me\n");
    try gitCommitAll(alloc, io, tmp.dir, "fork point");
    const fork_point = try proc.run(alloc, io, tmp.dir, &.{ "git", "rev-parse", "HEAD" });
    defer alloc.free(fork_point.stdout);
    defer alloc.free(fork_point.stderr);

    // Upstream moves ahead so the merge base is strictly behind the tip —
    // which is the state that used to hide a real deletion.
    const branch = try proc.run(alloc, io, tmp.dir, &.{ "git", "checkout", "-q", "-b", "upstream-line" });
    defer alloc.free(branch.stdout);
    defer alloc.free(branch.stderr);
    try writeFileAt(io, tmp.dir, "upstream-only.txt", "upstream\n");
    try gitCommitAll(alloc, io, tmp.dir, "upstream work");
    const set_ref = try proc.run(alloc, io, tmp.dir, &.{ "git", "update-ref", "refs/remotes/upstream/main", "HEAD" });
    defer alloc.free(set_ref.stdout);
    defer alloc.free(set_ref.stderr);
    const back = try proc.run(alloc, io, tmp.dir, &.{ "git", "checkout", "-q", "main" });
    defer alloc.free(back.stdout);
    defer alloc.free(back.stderr);

    // Now this branch deletes a file it shared with upstream.
    const rm = try proc.run(alloc, io, tmp.dir, &.{ "git", "rm", "-q", "doomed.txt" });
    defer alloc.free(rm.stdout);
    defer alloc.free(rm.stderr);
    try gitCommitAll(alloc, io, tmp.dir, "drop doomed.txt");

    const deletions = try deletionsAgainstMergeBase(alloc, io, tmp.dir, "refs/remotes/upstream/main");
    defer freeDeletions(alloc, deletions);
    try testing.expectEqual(@as(usize, 1), deletions.len);
    try testing.expectEqualStrings("doomed.txt", deletions[0]);
}

// The exact shape this check shipped wrong twice: a path upstream moved is a
// rename there and a deletion here, so comparing the two deletion sets called
// a moved test drift. Upstream does not carry the old path any more, which is
// what the report claims it does.
test "a file upstream moved away is not drift, because upstream no longer carries that path" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const alloc = testing.allocator;
    const io = testing.io;

    try gitSetup(alloc, io, tmp.dir);

    try writeFileAt(io, tmp.dir, "moved.txt", "some test body that survives the move\n");
    try writeFileAt(io, tmp.dir, "keep.txt", "keep\n");
    try gitCommitAll(alloc, io, tmp.dir, "fork point");

    // Upstream moves the file somewhere else in the tree.
    const branch = try proc.run(alloc, io, tmp.dir, &.{ "git", "checkout", "-q", "-b", "upstream-line" });
    defer alloc.free(branch.stdout);
    defer alloc.free(branch.stderr);
    const mv = try proc.run(alloc, io, tmp.dir, &.{ "git", "mv", "moved.txt", "renamed.txt" });
    defer alloc.free(mv.stdout);
    defer alloc.free(mv.stderr);
    try gitCommitAll(alloc, io, tmp.dir, "upstream moves the file");
    const set_ref = try proc.run(alloc, io, tmp.dir, &.{ "git", "update-ref", "refs/remotes/upstream/main", "HEAD" });
    defer alloc.free(set_ref.stdout);
    defer alloc.free(set_ref.stderr);
    const back = try proc.run(alloc, io, tmp.dir, &.{ "git", "checkout", "-q", "main" });
    defer alloc.free(back.stdout);
    defer alloc.free(back.stderr);

    // This branch drops the same path without moving it.
    const rm = try proc.run(alloc, io, tmp.dir, &.{ "git", "rm", "-q", "moved.txt" });
    defer alloc.free(rm.stdout);
    defer alloc.free(rm.stderr);
    try gitCommitAll(alloc, io, tmp.dir, "drop moved.txt");

    // The deletion set still names it, which is the half that fooled the check.
    const deletions = try deletionsAgainstMergeBase(alloc, io, tmp.dir, "refs/remotes/upstream/main");
    defer freeDeletions(alloc, deletions);
    try testing.expectEqual(@as(usize, 1), deletions.len);
    try testing.expectEqualStrings("moved.txt", deletions[0]);

    // The question is whether upstream still carries the path, and it does not.
    const drift = try driftAgainstUpstream(alloc, io, tmp.dir, "refs/remotes/upstream/main");
    defer freeDeletions(alloc, drift);
    try testing.expectEqual(@as(usize, 0), drift.len);
}

test "a dropped file upstream still carries is drift, so the new half does not go blind" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const alloc = testing.allocator;
    const io = testing.io;

    try gitSetup(alloc, io, tmp.dir);

    try writeFileAt(io, tmp.dir, "doomed.txt", "delete me\n");
    try gitCommitAll(alloc, io, tmp.dir, "fork point");

    // Upstream keeps the file and works elsewhere.
    const branch = try proc.run(alloc, io, tmp.dir, &.{ "git", "checkout", "-q", "-b", "upstream-line" });
    defer alloc.free(branch.stdout);
    defer alloc.free(branch.stderr);
    try writeFileAt(io, tmp.dir, "upstream-only.txt", "upstream\n");
    try gitCommitAll(alloc, io, tmp.dir, "upstream work");
    const set_ref = try proc.run(alloc, io, tmp.dir, &.{ "git", "update-ref", "refs/remotes/upstream/main", "HEAD" });
    defer alloc.free(set_ref.stdout);
    defer alloc.free(set_ref.stderr);
    const back = try proc.run(alloc, io, tmp.dir, &.{ "git", "checkout", "-q", "main" });
    defer alloc.free(back.stdout);
    defer alloc.free(back.stderr);

    const rm = try proc.run(alloc, io, tmp.dir, &.{ "git", "rm", "-q", "doomed.txt" });
    defer alloc.free(rm.stdout);
    defer alloc.free(rm.stderr);
    try gitCommitAll(alloc, io, tmp.dir, "drop doomed.txt");

    const drift = try driftAgainstUpstream(alloc, io, tmp.dir, "refs/remotes/upstream/main");
    defer freeDeletions(alloc, drift);
    try testing.expectEqual(@as(usize, 1), drift.len);
    try testing.expectEqualStrings("doomed.txt", drift[0]);
}

test "no merge base is an error rather than a silent pass" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const alloc = testing.allocator;
    const io = testing.io;

    try gitSetup(alloc, io, tmp.dir);
    try writeFileAt(io, tmp.dir, "only.txt", "only\n");
    try gitCommitAll(alloc, io, tmp.dir, "one commit");

    // A ref that does not exist, as in a shallow CI checkout with no upstream.
    try testing.expectError(
        error.NoMergeBase,
        deletionsAgainstMergeBase(alloc, io, tmp.dir, "refs/remotes/upstream/main"),
    );
}
