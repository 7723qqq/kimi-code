const std = @import("std");
const Io = std.Io;

const check = @import("../check.zig");
const fsutil = @import("../fsutil.zig");
const pkgjson = @import("../pkgjson.zig");
const walk = @import("../walk.zig");
const workflow = @import("../workflow.zig");

/// Scripts that a package manager or another tool invokes without anyone
/// naming them, so absence from the call graph is not evidence of dead code.
const LIFECYCLE_SCRIPTS = [_][]const u8{
    "postinstall", "preinstall",  "install",
    "prepare",     "prepack",     "postpack",
    "prepublish",  "prepublishOnly", "preversion",
    "version",     "postversion", "prebuild",
    "postbuild",   "predev",      "postdev",
    "prestart",    "poststart",   "pretest",
    "posttest",    "pretypecheck", "posttypecheck",
};

/// `apps/kimi-web` is outside the root workspace and installs on its own, so a
/// root script that means "run this here" is written as `cd apps/kimi-web`.
const SKIP_DIRS = [_][]const u8{
    "node_modules", "dist",     "dist-web", "dist-native", "coverage",
    ".git",         ".zig-cache", "zig-out",  "target",      "参考目录",
};

/// Scripts that are deliberately manual: a maintainer types them, so nothing
/// in the repository names them. Listed here so the ledger records that, and a
/// newly added script that nothing invokes still fails the run.
const BASELINE_PATH = "tools/review/scripts-wiring-baseline.txt";

pub fn run(ctx: *check.Context) !void {
    var arena = std.heap.ArenaAllocator.init(ctx.alloc);
    defer arena.deinit();
    const alloc = arena.allocator();

    const scripts = try collectScripts(ctx, alloc);
    if (scripts.len == 0) return;

    const wiring = try collectExternalWiring(ctx, alloc);

    const reachable = try reachableScripts(ctx, alloc, scripts, wiring);
    defer alloc.free(reachable);

    var baseline = try check.Baseline.load(ctx.alloc, ctx.io, ctx.root_dir, BASELINE_PATH);
    defer baseline.deinit();

    for (scripts) |script| {
        if (reachable[script.index]) continue;
        if (baseline.get(try ledgerKey(ctx.alloc, script))) |note| {
            _ = note;
            continue;
        }
        try ctx.report.add(.{
            .check = "scripts-wiring",
            .severity = .warn,
            .file = try ctx.alloc.dupe(u8, script.pkg_path),
            .message = try std.fmt.allocPrint(
                ctx.alloc,
                "script '{s}' is defined but nothing invokes it",
                .{script.name},
            ),
            .evidence = try std.fmt.allocPrint(
                ctx.alloc,
                "not reachable from the root scripts, .github/workflows/, the active hook, or another package's scripts; add it to {s} if it is meant to be run by hand",
                .{BASELINE_PATH},
            ),
        });
    }

    try baseline.reportStale(ctx, "scripts-wiring", BASELINE_PATH);
}

/// The ledger key is `<package.json path>:<script name>`, which survives the
/// edits that move a script's body around while still naming one script.
fn ledgerKey(alloc: std.mem.Allocator, script: Script) ![]const u8 {
    return std.fmt.allocPrint(alloc, "{s}:{s}", .{ script.pkg_path, script.name });
}

/// One `<package.json, script name>` pair, with a stable index used to mark it
/// reachable.
const Script = struct {
    pkg_index: usize,
    pkg_path: []const u8,
    name: []const u8,
    body: []const u8,
    index: usize,
};

const Package = struct {
    /// Directory, without the trailing `/package.json`.
    dir: []const u8,
    path: []const u8,
    name: []const u8,
};

fn collectPackages(ctx: *check.Context, alloc: std.mem.Allocator) ![]const Package {
    var out: std.ArrayList(Package) = .empty;

    const candidates = [_][]const u8{
        "package.json",
        "apps/kimi-web/package.json",
        "apps/vis/server/package.json",
        "apps/vis/web/package.json",
        "docs/package.json",
    };

    for (candidates) |rel| {
        try appendPackage(ctx, alloc, &out, rel);
    }

    // `packages/*` and `apps/*` are enumerated from the filesystem rather than
    // from the `workspaces` globs, so a member the globs forget is still
    // reviewed. `apps/vis` and `apps/kimi-web` are already covered above.
    for ([_][]const u8{ "packages", "apps" }) |parent| {
        if (Io.Dir.openDir(ctx.root_dir, ctx.io, parent, .{ .iterate = true })) |dir| {
            defer Io.Dir.close(dir, ctx.io);
            const dirs = walk.listDirs(alloc, ctx.io, dir) catch continue;
            defer walk.freeFiles(alloc, dirs);
            for (dirs) |child| {
                const rel = try std.fs.path.join(alloc, &.{ parent, child, "package.json" });
                try appendPackage(ctx, alloc, &out, rel);
            }
        } else |_| {}
    }

    return out.toOwnedSlice(alloc);
}

fn appendPackage(
    ctx: *check.Context,
    alloc: std.mem.Allocator,
    out: *std.ArrayList(Package),
    rel: []const u8,
) !void {
    const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, rel) orelse return;
    defer ctx.alloc.free(text);

    const parsed = std.json.parseFromSlice(std.json.Value, alloc, text, .{}) catch return;
    const root = switch (parsed.value) {
        .object => |o| o,
        else => return,
    };
    if (root.get("scripts") == null) return;

    const dir = if (std.mem.eql(u8, rel, "package.json"))
        ""
    else
        std.fs.path.dirname(rel) orelse "";

    const name = switch (root.get("name") orelse std.json.Value{ .null = {} }) {
        .string => |s| s,
        else => "",
    };

    try out.append(alloc, .{
        .dir = try alloc.dupe(u8, dir),
        .path = try alloc.dupe(u8, rel),
        .name = try alloc.dupe(u8, name),
    });
}

fn collectScripts(ctx: *check.Context, alloc: std.mem.Allocator) ![]const Script {
    const packages = try collectPackages(ctx, alloc);
    var out: std.ArrayList(Script) = .empty;

    for (packages, 0..) |pkg, i| {
        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, pkg.path) orelse continue;
        defer ctx.alloc.free(text);

        const parsed = std.json.parseFromSlice(std.json.Value, alloc, text, .{}) catch continue;
        const root = switch (parsed.value) {
            .object => |o| o,
            else => continue,
        };
        const scripts = switch (root.get("scripts") orelse continue) {
            .object => |o| o,
            else => continue,
        };

        var it = scripts.iterator();
        while (it.next()) |entry| {
            const body = switch (entry.value_ptr.*) {
                .string => |s| s,
                else => continue,
            };
            try out.append(alloc, .{
                .pkg_index = i,
                .pkg_path = pkg.path,
                .name = try alloc.dupe(u8, entry.key_ptr.*),
                .body = try alloc.dupe(u8, body),
                .index = out.items.len,
            });
        }
    }

    return out.toOwnedSlice(alloc);
}

/// Everything outside `package.json` that starts a script: the root scripts,
/// every `run:` command in `.github/workflows/`, and the active git hook.
fn collectExternalWiring(ctx: *check.Context, alloc: std.mem.Allocator) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;

    if (Io.Dir.openDir(ctx.root_dir, ctx.io, ".github/workflows", .{ .iterate = true })) |dir| {
        defer Io.Dir.close(dir, ctx.io);
        const files = walk.collectFiles(alloc, ctx.io, dir, .{}) catch &.{};
        defer walk.freeFiles(alloc, files);
        for (files) |rel| {
            const path = try std.fs.path.join(alloc, &.{ ".github/workflows", rel });
            const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, path) orelse continue;
            defer ctx.alloc.free(text);
            workflow.collectRunCommands(alloc, &out, text, path, .yes) catch continue;
        }
    } else |_| {}

    const hooks = [_][]const u8{ ".git/hooks/pre-commit", ".husky/pre-commit", ".husky/pre-push" };
    for (hooks) |hook| {
        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, hook) orelse continue;
        defer ctx.alloc.free(text);
        try out.appendSlice(alloc, text);
        try out.append(alloc, '\n');
    }

    // `simple-git-hooks` stores the hook command inline in package.json, which
    // `collectScripts` already reads; appending the whole file keeps the hook
    // body searchable without a second JSON walk.
    const root_text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, "package.json") orelse "";
    defer if (root_text.len > 0) ctx.alloc.free(root_text);
    try out.appendSlice(alloc, root_text);
    try out.append(alloc, '\n');

    return out.toOwnedSlice(alloc);
}

/// Mark every script reachable from an external entry point, following
/// `bun run X` / `npm run X` edges inside script bodies.
fn reachableScripts(
    ctx: *check.Context,
    alloc: std.mem.Allocator,
    scripts: []const Script,
    wiring: []const u8,
) ![]bool {
    const reachable = try alloc.alloc(bool, scripts.len);
    @memset(reachable, false);

    var queue: std.ArrayList(usize) = .empty;
    defer queue.deinit(alloc);

    for (scripts) |script| {
        if (isExternalEntry(script, wiring)) {
            reachable[script.index] = true;
            try queue.append(alloc, script.index);
        }
    }

    while (queue.pop()) |index| {
        const body = scripts[index].body;
        const pkg_dir = packageDir(scripts[index]);
        var cursor: usize = 0;
        while (nextInvocation(body, &cursor)) |invoked| {
            const dirs = try invocationDirs(ctx, alloc, pkg_dir, invoked.selector);
            defer {
                // The package's own directory is borrowed from the script
                // table; the filter-derived ones are owned by `invocationDirs`.
                for (dirs) |dir| {
                    if (!std.mem.eql(u8, dir, pkg_dir)) alloc.free(dir);
                }
                alloc.free(dirs);
            }

            for (dirs) |dir| {
                const target = resolveScript(scripts, dir, invoked.name) orelse continue;
                if (reachable[target]) continue;
                reachable[target] = true;
                try queue.append(alloc, target);
            }
        }
    }

    return reachable;
}

fn packageDir(script: Script) []const u8 {
    if (std.mem.eql(u8, script.pkg_path, "package.json")) return "";
    return std.fs.path.dirname(script.pkg_path) orelse "";
}

/// Where a `bun run` inside a script body looks for its target: the package's
/// own directory, plus every workspace member a `--filter` on the invocation
/// selects. A filter is how the root `build` reaches `packages/*/build`, so
/// ignoring it would call every member's build script dead.
fn invocationDirs(
    ctx: *check.Context,
    alloc: std.mem.Allocator,
    pkg_dir: []const u8,
    selector: ?[]const u8,
) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    try out.append(alloc, pkg_dir);

    const pattern_raw = selector orelse return out.toOwnedSlice(alloc);
    // Selectors are written as `./packages/*`, while script paths are stored
    // without the leading `./`, so the two must be normalized to compare.
    const pattern = if (std.mem.startsWith(u8, pattern_raw, "./")) pattern_raw[2..] else pattern_raw;
    if (!std.mem.endsWith(u8, pattern, "/*")) return out.toOwnedSlice(alloc);
    const parent = pattern[0 .. pattern.len - 2];

    if (Io.Dir.openDir(ctx.root_dir, ctx.io, parent, .{ .iterate = true })) |dir| {
        defer Io.Dir.close(dir, ctx.io);
        const dirs = walk.listDirs(alloc, ctx.io, dir) catch return out.toOwnedSlice(alloc);
        defer walk.freeFiles(alloc, dirs);
        for (dirs) |child| {
            try out.append(alloc, try std.fs.path.join(alloc, &.{ parent, child }));
        }
    } else |_| {}

    return out.toOwnedSlice(alloc);
}

/// An entry point is a root script, any script a workflow or hook names, or a
/// lifecycle hook the package manager fires on its own.
fn isExternalEntry(script: Script, wiring: []const u8) bool {
    if (std.mem.eql(u8, script.pkg_path, "package.json")) return true;
    if (isLifecycle(script.name)) return true;
    return mentionsScript(wiring, script.name);
}

fn isLifecycle(name: []const u8) bool {
    for (LIFECYCLE_SCRIPTS) |hook| {
        if (std.mem.eql(u8, name, hook)) return true;
    }
    return false;
}

/// Does the wiring text name this script as a `run` target? Substring matching
/// alone would call `build` wired because `build:packages` appears, so the
/// match has to end on a boundary that cannot continue the name.
fn mentionsScript(wiring: []const u8, name: []const u8) bool {
    if (name.len == 0) return false;
    return indexOfInvocation(wiring, name) != null;
}

fn indexOfInvocation(haystack: []const u8, name: []const u8) ?usize {
    var cursor: usize = 0;
    while (std.mem.indexOfPos(u8, haystack, cursor, name)) |at| {
        cursor = at + 1;
        if (!atBoundary(haystack, at)) continue;
        const end = at + name.len;
        if (end < haystack.len and isNameByte(haystack[end])) continue;
        return at;
    }
    return null;
}

/// The character before a name must not be one that could extend it, so
/// `build:deps` is not mistaken for a mention of `deps`.
fn atBoundary(haystack: []const u8, at: usize) bool {
    if (at == 0) return true;
    const prev = haystack[at - 1];
    return !isNameByte(prev);
}

fn isNameByte(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == ':' or c == '-' or c == '_';
}

/// `std.mem.trimStart` for these byte sets: leading characters in `set` are
/// dropped, everything else is left alone.
fn trimStart(comptime T: type, s: []const T, set: []const T) []const T {
    var i: usize = 0;
    while (i < s.len and std.mem.indexOfScalar(T, set, s[i]) != null) i += 1;
    return s[i..];
}

/// A `bun run X` / `npm run X` edge, wherever it appears in a script body.
/// `--filter './packages/*'` between `run` and the script name is honoured
/// because the directory it selects is what `resolveScript` uses to pick the
/// target.
const Invocation = struct {
    name: []const u8,
    /// The `--filter` selector preceding the invocation, when there is one.
    selector: ?[]const u8,
};

fn nextInvocation(body: []const u8, cursor: *usize) ?Invocation {
    const markers = [_][]const u8{ "bun run ", "npm run " };
    var best: ?usize = null;
    var marker_len: usize = 0;
    for (markers) |marker| {
        if (std.mem.indexOfPos(u8, body, cursor.*, marker)) |at| {
            if (best == null or at < best.?) {
                best = at;
                marker_len = marker.len;
            }
        }
    }
    const at = best orelse return null;
    const after_marker = at + marker_len;

    var rest = body[after_marker..];
    var selector: ?[]const u8 = null;

    // The repository writes `bun run [--filter <selector>] <script>`, so the
    // flags between `run` and the name have to be consumed before the name is
    // read. Reading the first token as the name would make `build` unreachable
    // under `bun run --filter './packages/*' build`.
    while (true) {
        const trimmed = trimStart(u8, rest, " \t");
        if (trimmed.len == 0) return null;
        if (!std.mem.startsWith(u8, trimmed, "--")) break;

        const flag_end = std.mem.indexOfAny(u8, trimmed, " \t") orelse break;
        const flag = trimmed[0..flag_end];
        var remainder = trimStart(u8, trimmed[flag_end..], " \t");

        if (std.mem.eql(u8, flag, "--filter")) {
            var arg_end: usize = 0;
            if (remainder.len > 0 and (remainder[0] == '\'' or remainder[0] == '"')) {
                const quote = remainder[0];
                const close = std.mem.indexOfScalar(u8, remainder[1..], quote) orelse return null;
                arg_end = close + 2;
                selector = remainder[1 .. arg_end - 1];
            } else {
                while (arg_end < remainder.len and remainder[arg_end] != ' ' and remainder[arg_end] != '\t') arg_end += 1;
                if (arg_end > 0) selector = remainder[0..arg_end];
            }
            remainder = trimStart(u8, remainder[arg_end..], " \t");
        }
        rest = remainder;
    }

    var end: usize = 0;
    while (end < rest.len and isNameByte(rest[end])) end += 1;
    if (end == 0) return null;

    // Resume the scan after the name, so the next `bun run` in the body is
    // found rather than this one matched again. `rest` is a sub-slice of
    // `body`, so the offset comes from the pointer distance rather than from
    // lengths.
    cursor.* = @intFromPtr(rest.ptr) - @intFromPtr(body.ptr) + end;

    return .{
        .name = rest[0..end],
        .selector = selector,
    };
}

/// Find the script an invocation names, preferring the package the invocation
/// runs in over a same-named script elsewhere in the monorepo.
fn resolveScript(scripts: []const Script, from_dir: []const u8, name: []const u8) ?usize {
    for (scripts) |script| {
        if (!std.mem.eql(u8, script.name, name)) continue;
        if (std.mem.eql(u8, std.fs.path.dirname(script.pkg_path) orelse "", from_dir)) return script.index;
    }
    // `cd apps/x && bun run y`: the body names the directory, so the first
    // script with the right name is the right answer often enough.
    for (scripts) |script| {
        if (std.mem.eql(u8, script.name, name)) return script.index;
    }
    return null;
}

const testing = std.testing;

/// A context rooted at this tool's own directory. The reachability tests only
/// need it to open `--filter` parents, and `packages/../packages` does not
/// exist here, so an unmatched filter simply contributes no directories.
fn testCtx(alloc: std.mem.Allocator) check.Context {
    return .{
        .alloc = alloc,
        .io = testing.io,
        .root_dir = Io.Dir.cwd(),
        .report = undefined,
    };
}

test "isLifecycle recognises the hooks a package manager fires" {
    try testing.expect(isLifecycle("postinstall"));
    try testing.expect(isLifecycle("prepare"));
    try testing.expect(isLifecycle("predev"));
    try testing.expect(!isLifecycle("build"));
    try testing.expect(!isLifecycle("dev"));
}

test "mentionsScript does not match a longer script name" {
    try testing.expect(mentionsScript("bun run build:packages", "build:packages"));
    try testing.expect(!mentionsScript("bun run build:packages", "build"));
    try testing.expect(!mentionsScript("bun run build:packages", "packages"));
    try testing.expect(mentionsScript("&& bun run typecheck &&", "typecheck"));
}

test "nextInvocation reads the name after the marker" {
    var cursor: usize = 0;
    const first = nextInvocation("bun run lint && bun run test", &cursor).?;
    try testing.expectEqualStrings("lint", first.name);
    const second = nextInvocation("bun run lint && bun run test", &cursor).?;
    try testing.expectEqualStrings("test", second.name);
    try testing.expect(nextInvocation("bun run lint && bun run test", &cursor) == null);
}

test "nextInvocation ignores a bare bunx invocation" {
    var cursor: usize = 0;
    try testing.expect(nextInvocation("bunx simple-git-hooks", &cursor) == null);
}

test "indexOfInvocation respects name boundaries" {
    try testing.expect(indexOfInvocation("bun run build:packages", "build") == null);
    try testing.expect(indexOfInvocation("bun run build", "build") != null);
}

test "directories resolve a same-named script to the invoking package" {
    const scripts = [_]Script{
        .{ .pkg_index = 0, .pkg_path = "package.json", .name = "build", .body = "", .index = 0 },
        .{ .pkg_index = 1, .pkg_path = "apps/kimi-code/package.json", .name = "build", .body = "", .index = 1 },
    };
    try testing.expectEqual(@as(?usize, 1), resolveScript(&scripts, "apps/kimi-code", "build"));
    try testing.expectEqual(@as(?usize, 0), resolveScript(&scripts, "", "build"));
}

test "reachableScripts follows an edge from the root script into a package" {
    const alloc = testing.allocator;
    const scripts = [_]Script{
        .{ .pkg_index = 0, .pkg_path = "package.json", .name = "build", .body = "bun run --filter './packages/*' build", .index = 0 },
        .{ .pkg_index = 1, .pkg_path = "packages/x/package.json", .name = "build", .body = "tsdown", .index = 1 },
        .{ .pkg_index = 1, .pkg_path = "packages/x/package.json", .name = "clean", .body = "rm -rf dist", .index = 2 },
    };
    const wiring = "bun install --frozen-lockfile";
    // `--filter './packages/*'` is expanded against the root the context
    // carries, so the test builds that shape on disk instead of depending on
    // where the test binary happens to run.
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(testing.io, "packages/x");

    var ctx: check.Context = .{
        .alloc = alloc,
        .io = testing.io,
        .root_dir = tmp.dir,
        .report = undefined,
    };
    const reachable = try reachableScripts(&ctx, alloc, &scripts, wiring);
    defer alloc.free(reachable);

    try testing.expect(reachable[0]);
    try testing.expect(reachable[1]);
    try testing.expect(!reachable[2]);
}
