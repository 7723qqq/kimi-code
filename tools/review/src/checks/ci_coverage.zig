const std = @import("std");
const Io = std.Io;

const check = @import("../check.zig");
const fsutil = @import("../fsutil.zig");
const pkgjson = @import("../pkgjson.zig");
const walk = @import("../walk.zig");

/// A workspace member whose tests or typecheck never run in CI is invisible to
/// every other gate: the suite is green because the suite never sees it.
pub fn run(ctx: *check.Context) !void {
    // Without the root manifest the workspace membership is unknown, so no
    // member can be judged. Reported rather than skipped: a check that quietly
    // does nothing reports the same green as one that found nothing wrong.
    var root_pkg = pkgjson.loadOrNull(ctx.alloc, ctx.io, ctx.root_dir, "package.json") orelse {
        try ctx.report.add(.{
            .check = "ci-coverage",
            .severity = .info,
            .file = "package.json",
            .message = "the root package.json could not be read, so no workspace member was checked",
            .evidence = "the workspace list and the root typecheck script both live in this file",
        });
        return;
    };
    defer root_pkg.deinit();

    const globs = try workspaceGlobs(ctx, &root_pkg);
    defer freeStrings(ctx.alloc, globs);

    const members = try expandGlobs(ctx, globs);
    defer freeStrings(ctx.alloc, members);

    const test_projects = try vitestProjects(ctx);
    defer freeStrings(ctx.alloc, test_projects);

    const runner = try workspaceTestRunner(ctx, &root_pkg);
    defer if (runner) |r| ctx.alloc.free(r);

    const workflows = try workflowText(ctx);
    defer ctx.alloc.free(workflows);

    const root_typecheck = root_pkg.script("typecheck") orelse "";

    if (runner != null) {
        try ctx.report.add(.{
            .check = "ci-coverage",
            .severity = .info,
            .file = "package.json",
            .message = "test coverage comes from one workspace-wide runner rather than per-package listings",
            .evidence = try std.fmt.allocPrint(
                ctx.alloc,
                "{s} walks every workspace member and runs its own test script, so no member is listed here",
                .{runner.?},
            ),
        });
    }

    for (members) |member| {
        const pkg_path = try std.fs.path.join(ctx.alloc, &.{ member, "package.json" });
        var member_pkg = pkgjson.loadOrNull(ctx.alloc, ctx.io, ctx.root_dir, pkg_path) orelse continue;
        defer member_pkg.deinit();

        if (member_pkg.hasScript("test") and
            runner == null and
            !matchesAny(test_projects, member) and
            std.mem.indexOf(u8, workflows, member) == null)
        {
            try ctx.report.add(.{
                .check = "ci-coverage",
                .severity = .err,
                .file = pkg_path,
                .message = "package declares a test script but no CI job, workspace runner, or test project runs it",
                .evidence = try std.fmt.allocPrint(
                    ctx.alloc,
                    "{s} is absent from the root test runner, from vitest.config.ts projects, and from .github/workflows/",
                    .{member},
                ),
            });
        }

        if (member_pkg.hasScript("typecheck") and
            !typecheckCovers(root_typecheck, member) and
            std.mem.indexOf(u8, workflows, member) == null)
        {
            try ctx.report.add(.{
                .check = "ci-coverage",
                .severity = .warn,
                .file = pkg_path,
                .message = "package declares a typecheck script that neither the root typecheck script nor CI runs",
                .evidence = try std.fmt.allocPrint(
                    ctx.alloc,
                    "{s} is absent from scripts.typecheck and from .github/workflows/",
                    .{member},
                ),
            });
        }
    }
}

/// The root `typecheck` script mixes globs (`--filter './packages/*'`) with
/// literal paths (`cd apps/kimi-code`), so both shapes have to be honoured.
fn typecheckCovers(script: []const u8, member: []const u8) bool {
    if (std.mem.indexOf(u8, script, member) != null) return true;

    var cursor: usize = 0;
    while (std.mem.indexOfScalarPos(u8, script, cursor, '\'')) |q1| {
        const q2 = std.mem.indexOfScalarPos(u8, script, q1 + 1, '\'') orelse break;
        var pattern = script[q1 + 1 .. q2];
        if (std.mem.startsWith(u8, pattern, "./")) pattern = pattern[2..];
        if (matchesGlob(pattern, member)) return true;
        cursor = q2 + 1;
    }
    return false;
}

fn workspaceGlobs(ctx: *check.Context, root_pkg: *const pkgjson.PackageJson) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    errdefer out.deinit(ctx.alloc);

    const ws = root_pkg.root().get("workspaces") orelse return out.toOwnedSlice(ctx.alloc);
    const obj = switch (ws) {
        .object => |o| o,
        else => return out.toOwnedSlice(ctx.alloc),
    };
    const packages = obj.get("packages") orelse return out.toOwnedSlice(ctx.alloc);
    const arr = switch (packages) {
        .array => |a| a,
        else => return out.toOwnedSlice(ctx.alloc),
    };
    for (arr.items) |item| {
        switch (item) {
            .string => |s| try out.append(ctx.alloc, s),
            else => {},
        }
    }
    return out.toOwnedSlice(ctx.alloc);
}

/// Expand `packages/*`-style globs into concrete member directories, applying
/// `!`-prefixed exclusions.
fn expandGlobs(ctx: *check.Context, globs: []const []const u8) ![]const []const u8 {
    var included: std.ArrayList([]const u8) = .empty;
    defer freeStrings(ctx.alloc, included.items);
    var excluded: std.ArrayList([]const u8) = .empty;
    defer excluded.deinit(ctx.alloc);

    for (globs) |g| {
        if (std.mem.startsWith(u8, g, "!")) {
            try excluded.append(ctx.alloc, g[1..]);
            continue;
        }
        if (std.mem.endsWith(u8, g, "/*")) {
            const parent = g[0 .. g.len - 2];
            if (Io.Dir.openDir(ctx.root_dir, ctx.io, parent, .{ .iterate = true })) |dir| {
                defer Io.Dir.close(dir, ctx.io);
                const dirs = walk.listDirs(ctx.alloc, ctx.io, dir) catch continue;
                defer walk.freeFiles(ctx.alloc, dirs);
                for (dirs) |d| {
                    // Join with a forward slash on purpose. `std.fs.path.join`
                    // would emit `packages\<dir>` on Windows, and every
                    // consumer of this list — the vitest `projects` globs and the
                    // `.github/workflows/` text — is written with forward slashes,
                    // so a backslash member matches nothing and every package is
                    // reported as uncovered. Repository-relative paths in this
                    // check are always slash-separated.
                    try included.append(ctx.alloc, try std.fmt.allocPrint(
                        ctx.alloc,
                        "{s}/{s}",
                        .{ parent, d },
                    ));
                }
            } else |_| {}
            continue;
        }
        try included.append(ctx.alloc, try ctx.alloc.dupe(u8, g));
    }

    var out: std.ArrayList([]const u8) = .empty;
    errdefer freeStrings(ctx.alloc, out.items);
    for (included.items) |member| {
        var skip = false;
        for (excluded.items) |ex| {
            if (std.mem.eql(u8, member, ex)) skip = true;
        }
        if (!skip) try out.append(ctx.alloc, try ctx.alloc.dupe(u8, member));
    }
    return out.toOwnedSlice(ctx.alloc);
}

/// The script the root `test` script delegates to, when it is a runner that
/// walks the workspace and runs each member's own test script.
///
/// bun:test replaced vitest here, so the per-member project listing moved into
/// one runner (`scripts/run-tests.mjs`) that discovers members from the
/// workspace instead of from a config file. A member is covered by that shape
/// of runner without being named anywhere, so a check that only read project
/// listings would call every member uncovered — the state this repo sat in,
/// where the gate reported 16 members whose suites all ran.
///
/// The shape is detected rather than assumed: the runner has to walk
/// directories and read each one's package.json, which is what makes it
/// discover members rather than run a fixed list. A script that does neither
/// earns no coverage, so replacing the runner with a narrower one turns the
/// per-member findings back on instead of hiding them.
fn workspaceTestRunner(ctx: *check.Context, root_pkg: *const pkgjson.PackageJson) !?[]const u8 {
    const command = root_pkg.script("test") orelse return null;

    var candidate: ?[]const u8 = null;
    var tokens = std.mem.splitScalar(u8, command, ' ');
    while (tokens.next()) |raw| {
        const token = std.mem.trim(u8, raw, " \t\r");
        if (token.len == 0) continue;
        if (!std.mem.endsWith(u8, token, ".mjs") and
            !std.mem.endsWith(u8, token, ".js") and
            !std.mem.endsWith(u8, token, ".mts") and
            !std.mem.endsWith(u8, token, ".ts")) continue;
        candidate = token;
        break;
    }
    const path = candidate orelse return null;
    if (std.mem.indexOfScalar(u8, path, '/') == null) return null;

    const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, path) orelse return null;
    defer ctx.alloc.free(text);

    const walks = std.mem.indexOf(u8, text, "readdirSync") != null;
    const reads_manifests = std.mem.indexOf(u8, text, "package.json") != null;
    if (!walks or !reads_manifests) return null;

    return try ctx.alloc.dupe(u8, path);
}

/// The string literals inside `projects: [...]` in vitest.config.ts.
fn vitestProjects(ctx: *check.Context) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    errdefer out.deinit(ctx.alloc);

    const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, "vitest.config.ts") orelse
        return out.toOwnedSlice(ctx.alloc);
    defer ctx.alloc.free(text);

    const start = std.mem.indexOf(u8, text, "projects:") orelse return out.toOwnedSlice(ctx.alloc);
    const open = std.mem.indexOfScalarPos(u8, text, start, '[') orelse return out.toOwnedSlice(ctx.alloc);
    const close = std.mem.indexOfScalarPos(u8, text, open, ']') orelse return out.toOwnedSlice(ctx.alloc);

    var cursor = open;
    while (std.mem.indexOfScalarPos(u8, text[0..close], cursor, '\'')) |q1| {
        const q2 = std.mem.indexOfScalarPos(u8, text[0..close], q1 + 1, '\'') orelse break;
        try out.append(ctx.alloc, try ctx.alloc.dupe(u8, text[q1 + 1 .. q2]));
        cursor = q2 + 1;
    }
    return out.toOwnedSlice(ctx.alloc);
}

fn workflowText(ctx: *check.Context) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
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
        try out.appendSlice(ctx.alloc, text);
        try out.append(ctx.alloc, '\n');
    }
    return out.toOwnedSlice(ctx.alloc);
}

fn matchesAny(patterns: []const []const u8, path: []const u8) bool {
    var matched = false;
    for (patterns) |p| {
        if (std.mem.startsWith(u8, p, "!")) {
            if (matchesGlob(p[1..], path)) return false;
            continue;
        }
        if (matchesGlob(p, path)) matched = true;
    }
    return matched;
}

/// Supports the two shapes used in vitest.config.ts: an exact path, and a
/// single-level `parent/*` wildcard.
fn matchesGlob(pattern: []const u8, path: []const u8) bool {
    if (!std.mem.endsWith(u8, pattern, "/*")) return std.mem.eql(u8, pattern, path);
    const parent = pattern[0 .. pattern.len - 2];
    if (!std.mem.startsWith(u8, path, parent)) return false;
    if (path.len <= parent.len + 1) return false;
    if (path[parent.len] != '/') return false;
    return std.mem.indexOfScalar(u8, path[parent.len + 1 ..], '/') == null;
}

fn freeStrings(alloc: std.mem.Allocator, items: []const []const u8) void {
    for (items) |s| alloc.free(s);
    alloc.free(items);
}

const testing = std.testing;

test "matchesGlob handles exact paths and single-level wildcards" {
    try testing.expect(matchesGlob("apps/kimi-code", "apps/kimi-code"));
    try testing.expect(!matchesGlob("apps/kimi-code", "apps/kimi-inspect"));

    try testing.expect(matchesGlob("packages/*", "packages/minidb"));
    try testing.expect(!matchesGlob("packages/*", "packages/vis/server"));
    try testing.expect(!matchesGlob("packages/*", "packages"));
    try testing.expect(!matchesGlob("packages/*", "apps/kimi-code"));
}

test "matchesAny applies exclusions after inclusions" {
    const projects = [_][]const u8{ "packages/*", "!packages/minidb", "apps/kimi-code" };
    try testing.expect(matchesAny(&projects, "packages/kosong"));
    try testing.expect(!matchesAny(&projects, "packages/minidb"));
    try testing.expect(matchesAny(&projects, "apps/kimi-code"));
    try testing.expect(!matchesAny(&projects, "apps/kimi-inspect"));
}

test "typecheckCovers honours both the filter glob and the literal cd path" {
    const script = "bun run build:packages && bun run --filter './packages/*' typecheck && (cd apps/kimi-code && bun run typecheck) && (cd apps/vscode && bun run typecheck)";

    try testing.expect(typecheckCovers(script, "packages/kosong"));
    try testing.expect(typecheckCovers(script, "packages/agent-core-v2"));
    try testing.expect(typecheckCovers(script, "apps/kimi-code"));
    try testing.expect(typecheckCovers(script, "apps/vscode"));
    try testing.expect(!typecheckCovers(script, "apps/kimi-inspect"));
}
