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
    /// The workflow is triggered only by `workflow_call`: it is a library, and
    /// its jobs run exactly when some other workflow calls it. This is a
    /// property of the workflow, not of the job — the job that ends up in the
    /// callee carries no `uses:` of its own, so asking the job is the wrong
    /// question and answers "no" for every reusable workflow's jobs.
    from_reusable_workflow: bool,
};

/// A `workflow_call`-only workflow has no triggers of its own, so asking
/// whether *it* runs on a pull request always answers no. What decides the
/// question is its callers: `_native-build.yml` never runs on a PR by itself,
/// but a PR-triggered workflow calling it makes its jobs pre-merge gates. The
/// check therefore reads every workflow's job-level
/// `uses: ./.github/workflows/<file>` references before judging such a job.
///
/// The relation is not transitive. A workflow called only by another
/// `workflow_call`-only workflow is still not reached on a pull request, so a
/// candidate's own callers are inspected rather than the closure.
const Workflow = struct {
    /// Path relative to the repository root, e.g. `.github/workflows/ci.yml`.
    path: []const u8,
    /// The basename, which is what a `uses:` edge names.
    file_name: []const u8,
    /// The workflow has an `on: pull_request:` trigger.
    runs_on_pr: bool,
    /// `on:` carries `workflow_call` and no other trigger.
    call_only: bool,
    /// The files this workflow calls at job level: the basenames after
    /// `uses: ./.github/workflows/`.
    calls: []const []const u8,
};

/// True when `path` names a called workflow that some pull-request-triggered
/// workflow reaches.
fn calledByPrWorkflow(workflows: []const Workflow, path: []const u8) bool {
    const target = std.fs.path.basename(path);
    for (workflows) |caller| {
        if (!caller.runs_on_pr) continue;
        for (caller.calls) |callee| {
            if (std.mem.eql(u8, callee, target)) return true;
        }
    }
    return false;
}

/// The check could not read the pipeline list, so it reports nothing about it.
/// Silence here would read as "no problem", which is the failure mode this
/// tool exists to remove: a gate that cannot run must say so.
fn reportNoClaims(ctx: *check.Context) !void {
    try ctx.report.add(.{
        .check = "workflow-triggers",
        .severity = .info,
        .file = DOCS[0],
        .message = "no CI pipeline job list found, so no documented gate could be checked",
        .evidence = try std.fmt.allocPrint(
            ctx.alloc,
            "expected numbered `**job**` bullets under a `### CI pipeline` heading in {s}",
            .{DOCS[0]},
        ),
    });
}

/// No workflow file could be read, so the question cannot be answered either
/// way. Reported rather than skipped.
fn reportNoWorkflows(ctx: *check.Context) !void {
    try ctx.report.add(.{
        .check = "workflow-triggers",
        .severity = .info,
        .file = ".github/workflows",
        .message = "no workflow could be read, so no documented gate could be matched to a job",
        .evidence = "expected parseable YAML files under .github/workflows/",
    });
}

pub fn run(ctx: *check.Context) !void {
    const claims = try pipelineClaims(ctx);
    defer freeStrings(ctx.alloc, claims);
    if (claims.len == 0) {
        try reportNoClaims(ctx);
        return;
    }

    const workflows = try workflowTable(ctx);
    defer freeWorkflows(ctx.alloc, workflows);
    if (workflows.len == 0) {
        try reportNoWorkflows(ctx);
        return;
    }

    const jobs = try workflowJobs(ctx, workflows);
    defer freeJobs(ctx.alloc, jobs);
    if (jobs.len == 0) {
        try reportNoWorkflows(ctx);
        return;
    }

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

        // A workflow that only `workflow_call` reaches inherits its callers'
        // triggers, so its jobs are reported only when no caller runs on a PR.
        if (job.from_reusable_workflow and calledByPrWorkflow(workflows, job.workflow_path)) continue;

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

/// Read every workflow once: its triggers, the files it calls, and its jobs.
///
/// The table is built before the jobs so a reusable job can be judged against
/// its callers, which requires knowing every workflow's `on:` — including the
/// caller's — before deciding.
fn workflowTable(ctx: *check.Context) ![]const Workflow {
    var out: std.ArrayList(Workflow) = .empty;
    errdefer freeWorkflows(ctx.alloc, out.items);

    var unparsed: std.ArrayList([]const u8) = .empty;
    defer unparsed.deinit(ctx.alloc);

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
        // A workflow this reader cannot follow is skipped rather than guessed
        // at, and the file is recorded so the skip is reported instead of
        // passing as success.
        if (root.unsupported) {
            try unparsed.append(ctx.alloc, try ctx.alloc.dupe(u8, rel));
            continue;
        }

        const doc = root.map() orelse continue;

        try out.append(ctx.alloc, .{
            .path = try ctx.alloc.dupe(u8, path),
            .file_name = try ctx.alloc.dupe(u8, std.fs.path.basename(path)),
            .runs_on_pr = triggersOnPullRequest(doc),
            .call_only = triggersOnlyOnWorkflowCall(doc),
            .calls = try calledWorkflowFiles(ctx, doc),
        });
    }

    defer {
        for (unparsed.items) |u| ctx.alloc.free(u);
    }
    try reportUnsupportedWorkflows(ctx, unparsed.items);

    return out.toOwnedSlice(ctx.alloc);
}

/// The `./.github/workflows/<file>` basenames a workflow calls at job level.
///
/// Only job-level `uses:` counts. A step-level `uses:` names an action
/// (`actions/checkout@v4`, or a local `./.github/actions/...` composite), which
/// is not a workflow and carries no triggers of its own.
fn calledWorkflowFiles(ctx: *check.Context, doc: workflow.Node.Map) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (out.items) |f| ctx.alloc.free(f);
        out.deinit(ctx.alloc);
    }

    const jobs = doc.getMap("jobs") orelse return out.toOwnedSlice(ctx.alloc);
    const prefix = "./.github/workflows/";
    for (jobs.entries) |entry| {
        const job = switch (entry.value) {
            .map => |m| m,
            else => continue,
        };
        const uses = job.getScalar("uses") orelse continue;
        const trimmed = std.mem.trim(u8, uses, " \t'\"");
        if (!std.mem.startsWith(u8, trimmed, prefix)) continue;
        const file = trimmed[prefix.len..];
        if (file.len == 0) continue;
        try out.append(ctx.alloc, try ctx.alloc.dupe(u8, file));
    }
    return out.toOwnedSlice(ctx.alloc);
}

fn workflowJobs(ctx: *check.Context, workflows: []const Workflow) ![]const Job {
    var out: std.ArrayList(Job) = .empty;
    errdefer out.deinit(ctx.alloc);

    for (workflows) |wf| {
        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, wf.path) orelse continue;
        defer ctx.alloc.free(text);

        var root = try workflow.parse(ctx.alloc, text);
        defer root.deinit();
        if (root.unsupported) continue;

        const doc = root.map() orelse continue;
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
                .workflow_path = try ctx.alloc.dupe(u8, wf.path),
                .runs_on_pr = wf.runs_on_pr,
                .disabled = isDisabled(job),
                .from_reusable_workflow = wf.call_only,
            });
        }
    }
    return out.toOwnedSlice(ctx.alloc);
}

fn freeWorkflows(alloc: std.mem.Allocator, workflows: []const Workflow) void {
    for (workflows) |wf| {
        alloc.free(wf.path);
        alloc.free(wf.file_name);
        for (wf.calls) |f| alloc.free(f);
        alloc.free(wf.calls);
    }
    alloc.free(workflows);
}

/// Workflows the reader could not follow. Each is named rather than dropped:
/// a file silently skipped here is a set of jobs the check never judged, and
/// the run would still report success.
fn reportUnsupportedWorkflows(ctx: *check.Context, files: []const []const u8) !void {
    for (files) |rel| {
        const path = try std.fs.path.join(ctx.alloc, &.{ ".github/workflows", rel });
        try ctx.report.add(.{
            .check = "workflow-triggers",
            .severity = .info,
            .file = path,
            .message = "workflow could not be parsed, so its jobs were not checked",
            .evidence = "the file uses syntax this reader does not follow; its jobs are neither confirmed nor denied as pull-request gates",
        });
    }
}



/// True when the workflow's `on:` names `workflow_call` and nothing else.
///
/// A file can carry both, as `release.yml` does with `push` and
/// `workflow_dispatch`; only a workflow with no trigger of its own is a pure
/// library whose reachability is entirely its callers' business.
fn triggersOnlyOnWorkflowCall(doc: workflow.Node.Map) bool {
    const on = doc.get("on") orelse return false;

    var saw_workflow_call = false;
    var saw_other = false;
    switch (on) {
        .map => |m| {
            for (m.entries) |entry| {
                if (std.mem.eql(u8, entry.key, "workflow_call")) {
                    saw_workflow_call = true;
                } else {
                    saw_other = true;
                }
            }
        },
        .scalar => |s| {
            var it = std.mem.splitScalar(u8, std.mem.trim(u8, s, " \t[]"), ',');
            while (it.next()) |item| {
                const name = std.mem.trim(u8, item, " \t'\"");
                if (name.len == 0) continue;
                if (std.mem.eql(u8, name, "workflow_call")) saw_workflow_call = true else saw_other = true;
            }
        },
        .seq => |s| {
            for (s.items) |item| {
                switch (item) {
                    .scalar => |v| {
                        const name = std.mem.trim(u8, v, " \t'\"");
                        if (std.mem.eql(u8, name, "workflow_call")) saw_workflow_call = true else saw_other = true;
                    },
                    else => saw_other = true,
                }
            }
        },
    }
    return saw_workflow_call and !saw_other;
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
        .{ .name = "build", .workflow_path = "docs-deploy.yml", .runs_on_pr = false, .disabled = false, .from_reusable_workflow = false },
        .{ .name = "Native bundle (linux-x64)", .workflow_path = "_native-build.yml", .runs_on_pr = false, .disabled = false, .from_reusable_workflow = false },
        .{ .name = "build", .workflow_path = "ci.yml", .runs_on_pr = true, .disabled = false, .from_reusable_workflow = false },
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
        .{ .name = "Analyze (javascript-typescript)", .workflow_path = "codeql.yml", .runs_on_pr = false, .disabled = false, .from_reusable_workflow = false },
    };
    const found = findJob(&jobs, "Analyze (javascript-typescript)").?;
    try testing.expectEqualStrings("codeql.yml", found.workflow_path);
    try testing.expect(!found.runs_on_pr);
}

test "calledByPrWorkflow finds a reusable workflow a pull request reaches" {
    const calls = [_][]const u8{"_native-build.yml"};

    // A reusable workflow has no trigger of its own; what decides the question
    // is whether any caller runs on a pull request.
    const with_pr_caller = [_]Workflow{
        .{ .path = "ci.yml", .file_name = "ci.yml", .runs_on_pr = true, .call_only = false, .calls = &calls },
        .{ .path = "release.yml", .file_name = "release.yml", .runs_on_pr = false, .call_only = false, .calls = &calls },
        .{ .path = "_native-build.yml", .file_name = "_native-build.yml", .runs_on_pr = false, .call_only = true, .calls = &.{} },
    };
    try testing.expect(calledByPrWorkflow(&with_pr_caller, ".github/workflows/_native-build.yml"));

    // Every caller is push-only, so nothing runs it before the merge.
    const push_only_callers = [_]Workflow{
        .{ .path = "ci.yml", .file_name = "ci.yml", .runs_on_pr = true, .call_only = false, .calls = &.{} },
        .{ .path = "release.yml", .file_name = "release.yml", .runs_on_pr = false, .call_only = false, .calls = &calls },
        .{ .path = "_native-build.yml", .file_name = "_native-build.yml", .runs_on_pr = false, .call_only = true, .calls = &.{} },
    };
    try testing.expect(!calledByPrWorkflow(&push_only_callers, ".github/workflows/_native-build.yml"));

    // Nothing calls it at all.
    const uncalled = [_]Workflow{
        .{ .path = "ci.yml", .file_name = "ci.yml", .runs_on_pr = true, .call_only = false, .calls = &.{} },
        .{ .path = "_native-build.yml", .file_name = "_native-build.yml", .runs_on_pr = false, .call_only = true, .calls = &.{} },
    };
    try testing.expect(!calledByPrWorkflow(&uncalled, ".github/workflows/_native-build.yml"));
}

test "triggersOnlyOnWorkflowCall separates a library from a workflow with its own triggers" {
    const alloc = testing.allocator;

    // `workflow_call` alone: a library, reachable only through its callers.
    var call_only = try workflow.parse(alloc, "on:\n  workflow_call:\n");
    defer call_only.deinit();
    try testing.expect(triggersOnlyOnWorkflowCall(call_only.map().?));

    // `workflow_call` plus a real trigger is a workflow in its own right.
    var mixed = try workflow.parse(alloc, "on:\n  workflow_call:\n  workflow_dispatch:\n");
    defer mixed.deinit();
    try testing.expect(!triggersOnlyOnWorkflowCall(mixed.map().?));

    var push_only = try workflow.parse(alloc, "on:\n  push:\n    branches:\n      - main\n");
    defer push_only.deinit();
    try testing.expect(!triggersOnlyOnWorkflowCall(push_only.map().?));

    // The flow and bare forms reach the same answer.
    var flow = try workflow.parse(alloc, "on: [workflow_call]\n");
    defer flow.deinit();
    try testing.expect(triggersOnlyOnWorkflowCall(flow.map().?));

    var bare = try workflow.parse(alloc, "on: workflow_call\n");
    defer bare.deinit();
    try testing.expect(triggersOnlyOnWorkflowCall(bare.map().?));

    var no_on = try workflow.parse(alloc, "jobs:\n  x:\n    runs-on: ubuntu-latest\n");
    defer no_on.deinit();
    try testing.expect(!triggersOnlyOnWorkflowCall(no_on.map().?));
}

test "calledWorkflowFiles reads job-level uses and ignores steps and actions" {
    const alloc = testing.allocator;
    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    const a = arena.allocator();

    const src =
        \\on:
        \\  push:
        \\jobs:
        \\  release:
        \\    uses: ./.github/workflows/_native-build.yml
        \\  docs:
        \\    uses: "./.github/workflows/docs-deploy.yml"
        \\  build:
        \\    runs-on: ubuntu-latest
        \\    steps:
        \\      # a step-level action is not a workflow and carries no triggers
        \\      - uses: ./.github/actions/macos-notarize
        \\      - uses: actions/checkout@v4
    ;
    var root = try workflow.parse(a, src);
    defer root.deinit();

    const calls = try calledWorkflowFiles(dummyCtx(a), root.map().?);
    try testing.expectEqual(@as(usize, 2), calls.len);
    try testing.expectEqualStrings("_native-build.yml", calls[0]);
    try testing.expectEqualStrings("docs-deploy.yml", calls[1]);
}

test "calledWorkflowFiles returns nothing for a workflow with no jobs" {
    const alloc = testing.allocator;
    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    const a = arena.allocator();

    var root = try workflow.parse(a, "on:\n  push:\n");
    defer root.deinit();

    const calls = try calledWorkflowFiles(dummyCtx(a), root.map().?);
    try testing.expectEqual(@as(usize, 0), calls.len);
}

/// `calledWorkflowFiles` only allocates, so the context it needs never has to
/// touch the filesystem or the report.
fn dummyCtx(alloc: std.mem.Allocator) *check.Context {
    const holder = struct {
        var ctx: check.Context = undefined;
    };
    holder.ctx = .{ .alloc = alloc, .io = testing.io, .root_dir = Io.Dir.cwd(), .report = undefined };
    return &holder.ctx;
}
