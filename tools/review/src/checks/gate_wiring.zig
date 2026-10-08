const std = @import("std");
const Io = std.Io;

const check = @import("../check.zig");
const fsutil = @import("../fsutil.zig");
const walk = @import("../walk.zig");

/// Phrases that assert a script or workflow is wired into a gate. A script
/// mentioned without one of these is documentation of a manual tool, which is
/// legitimate and must not be flagged.
const CLAIM_MARKERS = [_][]const u8{
    "Enforced by",
    "enforced by",
    "runs as part of",
    "gated by",
    "fails the build",
};

const DOCS = [_][]const u8{ "DEVELOP.md", "README.md" };

/// Which hook manager actually owns `.git/hooks/`. A hook directory belonging
/// to the other manager is dead code: it is never executed, so a script it
/// references is not wired up no matter how it looks.
const HookManager = enum {
    husky,
    simple_git_hooks,
    none,

    fn activeHookDir(self: HookManager) ?[]const u8 {
        return switch (self) {
            .husky => ".husky",
            else => null,
        };
    }
};

pub fn run(ctx: *check.Context) !void {
    // The wiring text is assembled from this file plus the workflows, so
    // without it every documented gate would look unwired. Reported, not
    // skipped, for the same reason as the other checks: silence must not read
    // as a pass.
    const pkg = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, "package.json") orelse {
        try ctx.report.add(.{
            .check = "gate-wiring",
            .severity = .info,
            .file = "package.json",
            .message = "the root package.json could not be read, so no documented gate was checked",
            .evidence = "the scripts and the hook configuration this check resolves against live in this file",
        });
        return;
    };
    defer ctx.alloc.free(pkg);

    const manager = detectHookManager(pkg);
    try reportStaleHookDir(ctx, manager);

    var wiring: std.ArrayList(u8) = .empty;
    defer wiring.deinit(ctx.alloc);
    try collectWiring(ctx, &wiring, manager);

    for (DOCS) |doc| {
        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, doc) orelse continue;
        defer ctx.alloc.free(text);
        try scanDoc(ctx, doc, text, wiring.items, pkg);
    }
}

/// `simple-git-hooks` writes `.git/hooks/*` itself; `husky` owns `.husky/`.
/// When both are configured the generated hook wins, because that is what git
/// actually executes.
fn detectHookManager(pkg: []const u8) HookManager {
    if (std.mem.indexOf(u8, pkg, "\"simple-git-hooks\"") != null) return .simple_git_hooks;
    if (std.mem.indexOf(u8, pkg, "\"husky\"") != null) return .husky;
    return .none;
}

fn reportStaleHookDir(ctx: *check.Context, manager: HookManager) !void {
    if (manager == .husky) return;
    const hook = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, ".husky/pre-commit") orelse return;
    defer ctx.alloc.free(hook);

    try ctx.report.add(.{
        .check = "gate-wiring",
        .severity = .warn,
        .file = ".husky/pre-commit",
        .line = 1,
        .message = "stale hook directory: git runs the simple-git-hooks hook, so nothing here executes",
        .evidence = "package.json configures simple-git-hooks; .git/hooks/pre-commit is generated from it",
    });
}

fn collectWiring(
    ctx: *check.Context,
    out: *std.ArrayList(u8),
    manager: HookManager,
) !void {
    const pkg = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, "package.json") orelse return;
    defer ctx.alloc.free(pkg);
    try out.appendSlice(ctx.alloc, pkg);
    try out.append(ctx.alloc, '\n');

    if (manager.activeHookDir()) |dir_name| {
        if (Io.Dir.openDir(ctx.root_dir, ctx.io, dir_name, .{ .iterate = true })) |dir| {
            defer Io.Dir.close(dir, ctx.io);
            try appendTree(ctx, out, dir, dir_name);
        } else |_| {}
    }

    if (Io.Dir.openDir(ctx.root_dir, ctx.io, ".github/workflows", .{ .iterate = true })) |dir| {
        defer Io.Dir.close(dir, ctx.io);
        try appendTree(ctx, out, dir, ".github/workflows");
    } else |_| {
        // Without the workflows the wiring text is incomplete, so every script
        // a workflow runs would be reported as invoked by nothing. Saying so
        // is better than emitting a page of findings that are all wrong.
        try ctx.report.add(.{
            .check = "gate-wiring",
            .severity = .info,
            .file = ".github/workflows",
            .message = "the workflows directory could not be read, so scripts they invoke may look unwired",
            .evidence = "the wiring text is assembled from package.json, the active hook, and .github/workflows/",
        });
    }
}

fn appendTree(
    ctx: *check.Context,
    out: *std.ArrayList(u8),
    dir: Io.Dir,
    prefix: []const u8,
) !void {
    const files = walk.collectFiles(ctx.alloc, ctx.io, dir, .{}) catch return;
    defer walk.freeFiles(ctx.alloc, files);
    for (files) |rel| {
        const path = try std.fs.path.join(ctx.alloc, &.{ prefix, rel });
        defer ctx.alloc.free(path);
        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, path) orelse continue;
        defer ctx.alloc.free(text);
        try out.appendSlice(ctx.alloc, text);
        try out.append(ctx.alloc, '\n');
    }
}

fn scanDoc(
    ctx: *check.Context,
    doc: []const u8,
    text: []const u8,
    wiring: []const u8,
    pkg: []const u8,
) !void {
    var line_no: u32 = 0;
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        line_no += 1;
        if (!hasClaimMarker(line)) continue;

        var cursor: usize = 0;
        while (std.mem.indexOfScalarPos(u8, line, cursor, '`')) |open| {
            const close = std.mem.indexOfScalarPos(u8, line, open + 1, '`') orelse break;
            const span = line[open + 1 .. close];
            cursor = close + 1;
            try checkSpan(ctx, doc, line_no, span, line, wiring, pkg);
        }
    }
}

fn checkSpan(
    ctx: *check.Context,
    doc: []const u8,
    line_no: u32,
    span: []const u8,
    line: []const u8,
    wiring: []const u8,
    pkg: []const u8,
) !void {
    if (!std.mem.startsWith(u8, span, "scripts/")) return;
    if (!std.mem.endsWith(u8, span, ".mjs") and !std.mem.endsWith(u8, span, ".cjs")) return;

    const name = std.fs.path.basename(span);

    // A claim naming a runner ("runs as part of `bun run lint`") is checked
    // against that runner specifically: appearing somewhere in the repo is not
    // enough when the doc promises a particular gate.
    if (namedRunner(line)) |runner| {
        if (scriptInvokes(pkg, runner, name)) return;
        try ctx.report.add(.{
            .check = "gate-wiring",
            .severity = .err,
            .file = doc,
            .line = line_no,
            .message = try std.fmt.allocPrint(
                ctx.alloc,
                "{s} is documented as running under `bun run {s}`, which does not invoke it",
                .{ name, runner },
            ),
            .evidence = try std.fmt.allocPrint(
                ctx.alloc,
                "package.json scripts.{s} does not mention {s}",
                .{ runner, name },
            ),
        });
        return;
    }

    if (std.mem.indexOf(u8, wiring, name) != null) return;

    try ctx.report.add(.{
        .check = "gate-wiring",
        .severity = .err,
        .file = doc,
        .line = line_no,
        .message = try std.fmt.allocPrint(
            ctx.alloc,
            "{s} is documented as a gate but no active gate invokes it",
            .{name},
        ),
        .evidence = "not found in package.json, the active hook directory, or .github/workflows/",
    });
}

/// Extract `X` from a `` `bun run X` `` span on this line, if present.
fn namedRunner(line: []const u8) ?[]const u8 {
    const marker = "bun run ";
    const at = std.mem.indexOf(u8, line, marker) orelse return null;
    const rest = line[at + marker.len ..];
    var end: usize = 0;
    while (end < rest.len and (std.ascii.isAlphanumeric(rest[end]) or rest[end] == ':' or rest[end] == '-' or rest[end] == '_')) {
        end += 1;
    }
    if (end == 0) return null;
    return rest[0..end];
}

/// Does `package.json`'s `scripts.<runner>` line mention `name`?
/// Scripts are one per line in this repository, so the value is the rest of
/// the line after the key.
fn scriptInvokes(pkg: []const u8, runner: []const u8, name: []const u8) bool {
    var key_buf: [128]u8 = undefined;
    const key = std.fmt.bufPrint(&key_buf, "\"{s}\":", .{runner}) catch return false;
    const at = std.mem.indexOf(u8, pkg, key) orelse return false;
    const rest = pkg[at + key.len ..];
    const line_end = std.mem.indexOfScalar(u8, rest, '\n') orelse rest.len;
    return std.mem.indexOf(u8, rest[0..line_end], name) != null;
}

fn hasClaimMarker(line: []const u8) bool {
    for (CLAIM_MARKERS) |marker| {
        if (std.mem.indexOf(u8, line, marker) != null) return true;
    }
    return false;
}

const testing = std.testing;

/// Findings keep their message strings for the lifetime of the run, so the
/// tests hand them an arena rather than the leak-checking allocator.
fn testCtx(alloc: std.mem.Allocator, rep: *@import("../report.zig").Report) check.Context {
    return .{
        .alloc = alloc,
        .io = testing.io,
        .root_dir = Io.Dir.cwd(),
        .report = rep,
    };
}

test "hasClaimMarker recognises the phrasing used in DEVELOP.md" {
    try testing.expect(hasClaimMarker(
        "Enforced by `scripts/check-no-comments.mjs` over `.ts` files, which runs as part of `bun run lint`.",
    ));
    try testing.expect(!hasClaimMarker(
        "- Run `bun scripts/scan-hardcoded-v2.mjs` to find hardcoded strings that should be localized.",
    ));
}

test "detectHookManager prefers simple-git-hooks because it owns .git/hooks" {
    try testing.expectEqual(HookManager.simple_git_hooks, detectHookManager(
        "{\"simple-git-hooks\":{\"pre-commit\":\"bunx lint-staged\"}}",
    ));
    try testing.expectEqual(HookManager.husky, detectHookManager("{\"devDependencies\":{\"husky\":\"^9\"}}"));
    try testing.expectEqual(HookManager.none, detectHookManager("{}"));
}

test "namedRunner extracts the runner from a bun run span" {
    try testing.expectEqualStrings("lint", namedRunner("which runs as part of `bun run lint`.").?);
    try testing.expectEqualStrings("test:coverage", namedRunner("as part of `bun run test:coverage`").?);
    try testing.expect(namedRunner("no runner here") == null);
}

test "scriptInvokes reads the value on the runner's own line" {
    const pkg =
        \\{
        \\  "scripts": {
        \\    "lint": "oxlint --type-aware",
        \\    "check:locale-keys": "bun scripts/check-locale-keys.mjs"
        \\  }
        \\}
    ;
    try testing.expect(!scriptInvokes(pkg, "lint", "check-no-comments.mjs"));
    try testing.expect(scriptInvokes(pkg, "check:locale-keys", "check-locale-keys.mjs"));
    try testing.expect(!scriptInvokes(pkg, "missing", "anything"));
}

test "checkSpan ignores non-script spans" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var rep = @import("../report.zig").Report.init(arena.allocator());
    defer rep.deinit();
    var ctx = testCtx(arena.allocator(), &rep);

    try checkSpan(&ctx, "DEVELOP.md", 1, "bun run lint", "x", "x", "{}");
    try checkSpan(&ctx, "DEVELOP.md", 2, "scripts/foo.ts", "x", "x", "{}");
    try testing.expectEqual(@as(usize, 0), rep.findings.items.len);
}

test "checkSpan reports a documented gate that no active gate invokes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var rep = @import("../report.zig").Report.init(arena.allocator());
    defer rep.deinit();
    var ctx = testCtx(arena.allocator(), &rep);

    try checkSpan(&ctx, "DEVELOP.md", 7, "scripts/ghost.mjs", "x", "package.json without it", "{}");
    try testing.expectEqual(@as(usize, 1), rep.findings.items.len);
    try testing.expectEqualStrings("gate-wiring", rep.findings.items[0].check);
    try testing.expectEqual(@as(u32, 7), rep.findings.items[0].line);
}

test "checkSpan reports a runner claim the runner does not honour" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var rep = @import("../report.zig").Report.init(arena.allocator());
    defer rep.deinit();
    var ctx = testCtx(arena.allocator(), &rep);

    const pkg = "{\"scripts\":{\"lint\":\"oxlint --type-aware\"}}";
    try checkSpan(
        &ctx,
        "DEVELOP.md",
        355,
        "scripts/check-no-comments.mjs",
        "Enforced by `scripts/check-no-comments.mjs`, which runs as part of `bun run lint`.",
        "irrelevant",
        pkg,
    );
    try testing.expectEqual(@as(usize, 1), rep.findings.items.len);
    try testing.expect(std.mem.indexOf(u8, rep.findings.items[0].message, "bun run lint") != null);
}

test "checkSpan stays quiet when the named runner does invoke the script" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var rep = @import("../report.zig").Report.init(arena.allocator());
    defer rep.deinit();
    var ctx = testCtx(arena.allocator(), &rep);

    const pkg = "{\"scripts\":{\"lint\":\"oxlint && bun scripts/check-no-comments.mjs\"}}";
    try checkSpan(
        &ctx,
        "DEVELOP.md",
        1,
        "scripts/check-no-comments.mjs",
        "Enforced by `scripts/check-no-comments.mjs`, which runs as part of `bun run lint`.",
        "irrelevant",
        pkg,
    );
    try testing.expectEqual(@as(usize, 0), rep.findings.items.len);
}
