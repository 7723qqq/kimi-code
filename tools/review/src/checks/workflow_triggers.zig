const std = @import("std");
const Io = std.Io;

const check = @import("../check.zig");
const fsutil = @import("../fsutil.zig");
const walk = @import("../walk.zig");
const workflow = @import("../workflow.zig");

/// A CI job the documentation lists that a pull request never runs.
///
/// `gate-wiring` reads the same pipeline section, but only for the scripts it
/// names: a bullet that mentions `check-locale-keys.mjs` is checked, while a
/// bullet for a whole job — "typecheck", "review", "native bundle" — is not.
/// That leaves the larger claim unguarded. A job whose workflow only triggers
/// on `push` runs after the merge, so its verdict arrives once the change is
/// already on `main`; the bullet reads as a pre-merge gate either way, which is
/// exactly the kind of silent drift this tool exists to catch.
///
/// Two things keep it quiet on purpose:
///   * a workflow with no `on: pull_request:` is skipped entirely — `findJob`
///     matches jobs by name against the documented bullets, and a push-only
///     workflow's jobs carry none of those names, so nothing is reported;
///   * a job that CI disables outright (`if: false`) is reported as information
///     rather than an error, since "temporarily disabled" is a decision someone
///     made and the check should not fail the run over it.
const DOCS = [_][]const u8{"DEVELOP.md"};

const SKIP_DIRS = [_][]const u8{
    "node_modules", "dist", "dist-web", "dist-native", "coverage",
    ".git",         ".zig-cache", "zig-out", "target", "参考目录",
};

/// A `N. **name** — …` bullet as it appears in the CI pipeline section.
const Claim = struct {
    name: []const u8,
    line: u32,
};

const Job = struct {
    name: []const u8,
    workflow_path: []const u8,
    /// The workflow has an `on: pull_request:` trigger.
    runs_on_pr: bool,
    /// The job carries `if: false`, so it never runs at all.
    disabled: bool,
    /// The job carries a non-empty `uses:`, making it a called workflow.
    reusable: bool,
};

pub fn run(ctx: *check.Context) !void {
    const claims = try pipelineClaims(ctx);
    defer freeStrings(ctx.alloc, claims);
    if (claims.len == 0) return;

    const jobs = try workflowJobs(ctx);
    defer freeJobs(ctx.alloc, jobs);
    if (jobs.len == 0) return;

    for (claims) |claim| {
        const job = findJob(jobs, claim.name) orelse continue;

        if (job.disabled) {
            try ctx.report.add(.{
                .check = "workflow-triggers",
                .severity = .info,
                .file = "DEVELOP.md",
                .line = claim.line,
                .message = try std.fmt.allocPrint(
                    ctx.alloc,
                    "the '{s}' job is documented as part of CI but is disabled with `if: false`",
                    .{claim.name},
                ),
                .evidence = try std.fmt.allocPrint(
                    ctx.alloc,
                    "{s} disables it; drop the bullet or the condition",
                    .{job.workflow_path},
                ),
            });
            continue;
        }

        if (job.runs_on_pr) continue;

        try ctx.report.add(.{
            .check = "workflow-triggers",
            .severity = .err,
            .file = "DEVELOP.md",
            .line = claim.line,
            .message = try std.fmt.allocPrint(
                ctx.alloc,
                "the '{s}' job is documented as a CI gate but no pull request runs it",
                .{claim.name},
            ),
            .evidence = try std.fmt.allocPrint(
                ctx.alloc,
                "{s} does not trigger on pull_request, so the job only reports after the merge",
                .{job.workflow_path},
            ),
        });
    }
}

/// The job bullets of DEVELOP.md's CI pipeline section.
///
/// Only that section is read. The list of jobs appears there and nowhere else,
/// so scanning the whole file would pull in the other numbered lists — the
/// performance budgets, the release steps — and report them as CI jobs.
fn pipelineClaims(ctx: *check.Context) ![]const Claim {
    var out: std.ArrayList(Claim) = .empty;
    errdefer out.deinit(ctx.alloc);

    const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, DOCS[0]) orelse
        return out.toOwnedSlice(ctx.alloc);
    defer ctx.alloc.free(text);

    var in_section = false;
    var line_no: u32 = 0;
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |raw| {
        line_no += 1;
        const line = std.mem.trim(u8, raw, " \t\r");

        if (std.mem.startsWith(u8, line, "### ")) {
            in_section = std.mem.eql(u8, line, "### CI pipeline");
            continue;
        }
        // A new top-level section ends the list.
        if (std.mem.startsWith(u8, line, "## ")) in_section = false;
        if (!in_section) continue;

        const name = bulletName(line) orelse continue;
        // The name points into `text`, which this function frees on the way
        // out, so it is copied here rather than borrowed.
        try out.append(ctx.alloc, .{
            .name = try ctx.alloc.dupe(u8, name),
            .line = line_no,
        });
    }
    return out.toOwnedSlice(ctx.alloc);
}

/// `1. **build** — Install, build…` yields `build`.
fn bulletName(line: []const u8) ?[]const u8 {
    var i: usize = 0;
    while (i < line.len and std.ascii.isDigit(line[i])) i += 1;
    if (i == 0 or i + 1 >= line.len) return null;
    if (line[i] != '.' or line[i + 1] != ' ') return null;
    if (!std.mem.startsWith(u8, line[i + 2 ..], "**")) return null;

    const rest = line[i + 4 ..];
    const end = std.mem.indexOf(u8, rest, "**") orelse return null;
    if (end == 0) return null;
    return rest[0..end];
}

fn workflowJobs(ctx: *check.Context) ![]const Job {
    var out: std.ArrayList(Job) = .empty;
    errdefer out.deinit(ctx.alloc);

    const dir = Io.Dir.openDir(ctx.root_dir, ctx.io, ".github/workflows", .{ .iterate = true }) catch
        return out.toOwnedSlice(ctx.alloc);
    defer Io.Dir.close(dir, ctx.io);

    const files = walk.collectFiles(ctx.alloc, ctx.io, dir, .{
        .suffixes = &.{ ".yml", ".yaml" },
    }) catch return out.toOwnedSlice(ctx.alloc);
    defer walk.freeFiles(ctx.alloc, files);

    for (files) |rel| {
        const path = try std.fs.path.join(ctx.alloc, &.{ ".github/workflows", rel });
        defer ctx.alloc.free(path);

        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, path) orelse continue;
        defer ctx.alloc.free(text);

        var root = try workflow.parse(ctx.alloc, text);
        defer root.deinit();
        // A workflow this reader cannot follow is skipped; a wrong answer about
        // which jobs a pull request runs is worse than no answer.
        if (root.unsupported) continue;

        const doc = root.map() orelse continue;
        const runs_on_pr = triggersOnPullRequest(doc);

        const jobs = doc.getMap("jobs") orelse continue;
        for (jobs.entries) |entry| {
            const job = switch (entry.value) {
                .map => |m| m,
                else => continue,
            };
            // The documented name is the job's key, except where the job sets
            // `name:`, which is what the checks list shows on GitHub.
            const display = job.getScalar("name") orelse entry.key;
            try out.append(ctx.alloc, .{
                .name = try ctx.alloc.dupe(u8, display),
                .workflow_path = try ctx.alloc.dupe(u8, path),
                .runs_on_pr = runs_on_pr,
                .disabled = isDisabled(job),
                .reusable = job.get("uses") != null,
            });
        }
    }
    return out.toOwnedSlice(ctx.alloc);
}

/// True when the workflow's `on:` includes `pull_request`.
///
/// Three shapes appear: the usual `on:\n  pull_request:`, the flow form
/// `on: [push, pull_request]`, and the bare `on: pull_request`. The reader
/// keeps a flow sequence as its own text, so that form is matched by splitting
/// on commas rather than by walking a parsed list.
fn triggersOnPullRequest(doc: workflow.Node.Map) bool {
    const on = doc.get("on") orelse return false;
    switch (on) {
        .map => |m| return m.get("pull_request") != null,
        .scalar => |s| {
            const text = std.mem.trim(u8, s, " \t");
            const inner = if (std.mem.startsWith(u8, text, "[") and std.mem.endsWith(u8, text, "]"))
                text[1 .. text.len - 1]
            else
                text;
            var it = std.mem.splitScalar(u8, inner, ',');
            while (it.next()) |item| {
                if (std.mem.eql(u8, std.mem.trim(u8, item, " \t'\""), "pull_request")) return true;
            }
            return false;
        },
        .seq => |s| {
            for (s.items) |item| {
                switch (item) {
                    .scalar => |v| if (std.mem.eql(u8, std.mem.trim(u8, v, " \t'\""), "pull_request")) return true,
                    else => {},
                }
            }
            return false;
        },
    }
}

/// `if: false` on the job, which is how CI parks a job without deleting it.
fn isDisabled(job: workflow.Node.Map) bool {
    const cond = job.getScalar("if") orelse return false;
    return std.mem.eql(u8, std.mem.trim(u8, cond, " \t"), "false");
}

/// Resolve a documented bullet to the job it names.
///
/// A name is not unique across workflows — three carry a `build` job, only one
/// of which is the CI one the bullet means. Picking the first match would let an
/// unrelated workflow decide the answer, so a job that runs on a pull request
/// wins, and only when none does is the first match reported.
fn findJob(jobs: []const Job, claim: []const u8) ?Job {
    var fallback: ?Job = null;
    for (jobs) |job| {
        if (!std.mem.eql(u8, job.name, claim)) continue;
        if (job.runs_on_pr and !job.disabled) return job;
        if (fallback == null) fallback = job;
    }
    return fallback;
}

fn freeJobs(alloc: std.mem.Allocator, jobs: []const Job) void {
    for (jobs) |job| {
        alloc.free(job.name);
        alloc.free(job.workflow_path);
    }
    alloc.free(jobs);
}

fn freeStrings(alloc: std.mem.Allocator, items: []const Claim) void {
    for (items) |item| alloc.free(item.name);
    alloc.free(items);
}

const testing = std.testing;

test "bulletName reads the numbered bullet shape" {
    try testing.expectEqualStrings("build", bulletName("1. **build** — Install, build, smoke test CLI bundle").?);
    try testing.expectEqualStrings("review", bulletName("7. **review** — `zig build` in `tools/review`").?);
    try testing.expectEqualStrings("native bundle", bulletName("6. **native bundle** — Built by `_native-build.yml`").?);
}

test "bulletName ignores prose, headings and unnumbered lines" {
    try testing.expect(bulletName("### CI pipeline") == null);
    try testing.expect(bulletName("- **build** — a dash bullet") == null);
    try testing.expect(bulletName("no bold here") == null);
    // The pipeline list runs past nine entries, so two digits are normal.
    try testing.expectEqualStrings("native bundle", bulletName("10. **native bundle** — x").?);
    // A key with no number is not a bullet.
    try testing.expect(bulletName(". **build** — x") == null);
}

test "triggersOnPullRequest reads the mapping, flow and scalar forms" {
    const alloc = testing.allocator;

    var mapping = try workflow.parse(alloc, "on:\n  pull_request:\n  push:\n");
    defer mapping.deinit();
    try testing.expect(triggersOnPullRequest(mapping.map().?));

    var push_only = try workflow.parse(alloc, "on:\n  push:\n    branches:\n      - main\n");
    defer push_only.deinit();
    try testing.expect(!triggersOnPullRequest(push_only.map().?));

    var flow = try workflow.parse(alloc, "on: [push, pull_request]\n");
    defer flow.deinit();
    try testing.expect(triggersOnPullRequest(flow.map().?));

    var scalar = try workflow.parse(alloc, "on: pull_request\n");
    defer scalar.deinit();
    try testing.expect(triggersOnPullRequest(scalar.map().?));
}

test "isDisabled reads only a literal if: false" {
    const alloc = testing.allocator;

    var parked = try workflow.parse(alloc, "jobs:\n  test-windows:\n    if: false\n    runs-on: windows-latest\n");
    defer parked.deinit();
    try testing.expect(isDisabled(parked.map().?.getMap("jobs").?.getMap("test-windows").?));

    var conditional = try workflow.parse(
        alloc,
        "jobs:\n  x:\n    if: github.event_name == 'pull_request'\n",
    );
    defer conditional.deinit();
    try testing.expect(!isDisabled(conditional.map().?.getMap("jobs").?.getMap("x").?));
}

test "findJob prefers the job a pull request actually runs" {
    const jobs = [_]Job{
        .{ .name = "build", .workflow_path = "docs-deploy.yml", .runs_on_pr = false, .disabled = false, .reusable = false },
        .{ .name = "Native bundle (linux-x64)", .workflow_path = "_native-build.yml", .runs_on_pr = false, .disabled = false, .reusable = false },
        .{ .name = "build", .workflow_path = "ci.yml", .runs_on_pr = true, .disabled = false, .reusable = false },
    };
    // Three workflows carry a `build` job; the CI one is the one meant.
    try testing.expectEqualStrings("ci.yml", findJob(&jobs, "build").?.workflow_path);
    try testing.expectEqualStrings(
        "_native-build.yml",
        findJob(&jobs, "Native bundle (linux-x64)").?.workflow_path,
    );
    try testing.expect(findJob(&jobs, "missing") == null);
}

test "findJob still reports a name whose only matches are push-only" {
    const jobs = [_]Job{
        .{ .name = "Analyze (javascript-typescript)", .workflow_path = "codeql.yml", .runs_on_pr = false, .disabled = false, .reusable = false },
    };
    const found = findJob(&jobs, "Analyze (javascript-typescript)").?;
    try testing.expectEqualStrings("codeql.yml", found.workflow_path);
    try testing.expect(!found.runs_on_pr);
}
