const std = @import("std");
const Io = std.Io;

const check = @import("../check.zig");
const fsutil = @import("../fsutil.zig");
const lexer = @import("../lexer.zig");
const paths = @import("../paths.zig");
const ts_scan = @import("../ts_scan.zig");
const walk = @import("../walk.zig");

/// Tool names that a list in the code names but nothing registers.
///
/// A permission policy, an agent profile, or a feature's tool list is a set of
/// tool names. When a tool is renamed or retired those lists keep the old
/// spelling and silently stop matching: the policy never approves anything, the
/// profile never offers the tool. Nothing fails, because a name that matches no
/// tool is not an error anywhere — it is just dead.
///
/// The check reads two things and compares them: every name a tool declares
/// itself by, and every string in a constant whose name ends in `TOOLS` or
/// `TOOL_NAMES`. It deliberately does not read prose — a prompt file mentions
/// parameter names and file names far more often than tool names, and guessing
/// which backticked word is which would bury the real findings.
const BASELINE_PATH = "tools/review/dangling-refs-baseline.txt";

/// Calls whose options carry the tool's registered name.
const REGISTERING_CALLS = [_][]const u8{ "defineTool", "registerAgentToolService", "contributeTool" };

const Mention = struct {
    name: []const u8,
    file: []const u8,
    line: u32,
    list: []const u8,
};

pub fn run(ctx: *check.Context) !void {
    const files = try walk.collectFiles(ctx.alloc, ctx.io, ctx.root_dir, .{
        .skip_dirs = &paths.SKIP_DIRS,
        .suffixes = &.{ ".ts", ".tsx", ".vue", ".js", ".mjs" },
    });
    defer walk.freeFiles(ctx.alloc, files);

    var registered: std.StringHashMap(void) = .init(ctx.alloc);
    defer freeKeySet(ctx.alloc, &registered);

    var mentions: std.ArrayList(Mention) = .empty;
    defer mentions.deinit(ctx.alloc);

    for (files) |rel| {
        if (!isSource(rel)) continue;

        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, rel) orelse continue;
        defer ctx.alloc.free(text);

        const lexed = lexer.lex(ctx.alloc, text) catch continue;
        defer lexer.deinit(ctx.alloc, lexed);
        if (!lexed.reliable) continue;

        try collectRegistered(ctx.alloc, lexed, rel, &registered);
        try collectMentions(ctx.alloc, lexed, rel, &mentions);
    }

    var baseline = try check.Baseline.load(ctx.alloc, ctx.io, ctx.root_dir, BASELINE_PATH);
    defer baseline.deinit();

    for (mentions.items) |m| {
        if (registered.contains(m.name)) continue;
        if (baseline.get(m.name) != null) continue;

        try ctx.report.add(.{
            .check = "dangling-refs",
            .severity = .err,
            .file = m.file,
            .line = m.line,
            .message = try std.fmt.allocPrint(
                ctx.alloc,
                "tool name '{s}' in {s} matches no registered tool",
                .{ m.name, m.list },
            ),
            .evidence = try std.fmt.allocPrint(
                ctx.alloc,
                "a name that matches no tool is never an error at runtime; the list just stops working. Add `{s}` to {s} if it is a legacy name kept on purpose",
                .{ m.name, BASELINE_PATH },
            ),
        });
    }

    try baseline.reportStale(ctx, "dangling-refs", BASELINE_PATH);
}

/// Every name a tool declares itself by.
fn collectRegistered(
    alloc: std.mem.Allocator,
    lexed: lexer.Lexed,
    rel: []const u8,
    into: *std.StringHashMap(void),
) !void {
    const toks = lexed.tokens;
    // `readonly name = 'x'` is how tool classes declare themselves, but plenty
    // of unrelated classes use the same shape, so only trust it in a file that
    // defines a tool or lives beside one.
    const tool_file = std.mem.indexOf(u8, rel, "/tools/") != null or containsIdent(lexed, "defineTool");

    var i: usize = 0;
    while (i < toks.len) : (i += 1) {
        // `export const X_TOOL_NAME = 'x'`. The `export` matters: a tool
        // declares its name by exporting it from its own module, while a local
        // constant of the same shape is a consumer — `auth.ts` builds
        // `mcp__<server>__authenticate` from a fragment, and treating that
        // fragment as a registered name would mask a real dangling reference.
        if (i > 0 and lexed.isIdent(toks[i - 1], "export") and
            lexed.isIdent(toks[i], "const") and i + 3 < toks.len)
        {
            const name_tok = toks[i + 1];
            if (name_tok.kind == .ident and
                std.mem.indexOf(u8, lexed.text(name_tok), "TOOL_NAME") != null and
                lexed.isPunct(toks[i + 2], '=') and toks[i + 3].kind == .string)
            {
                try addName(alloc, into, stringBody(lexed, toks[i + 3]));
            }
        }

        if (tool_file and lexed.isIdent(toks[i], "readonly") and i + 3 < toks.len and
            lexed.isIdent(toks[i + 1], "name") and lexed.isPunct(toks[i + 2], '=') and
            toks[i + 3].kind == .string)
        {
            try addName(alloc, into, stringBody(lexed, toks[i + 3]));
        }

        for (REGISTERING_CALLS) |call| {
            if (!lexed.isIdent(toks[i], call)) continue;
            if (i + 1 >= toks.len or !lexed.isPunct(toks[i + 1], '(')) continue;
            const end = ts_scan.skipBalanced(lexed, i + 1, '(', ')') orelse toks.len;
            var j = i + 2;
            while (j + 2 < end) : (j += 1) {
                if (!lexed.isIdent(toks[j], "name")) continue;
                if (!lexed.isPunct(toks[j + 1], ':')) continue;
                if (toks[j + 2].kind != .string) continue;
                try addName(alloc, into, stringBody(lexed, toks[j + 2]));
            }
        }
    }
}

/// Every string in a constant that names a set of tools.
///
/// The constant must end in `TOOLS` or `TOOL_NAMES`: a looser "mentions TOOL"
/// rule also catches `TOOL_HINT_KEYS` (argument names) and
/// `*_VISION_TOOL_PREFIXES` (model ids), neither of which is a tool name.
fn collectMentions(
    alloc: std.mem.Allocator,
    lexed: lexer.Lexed,
    rel: []const u8,
    out: *std.ArrayList(Mention),
) !void {
    const toks = lexed.tokens;
    var i: usize = 0;
    while (i + 3 < toks.len) : (i += 1) {
        if (!lexed.isIdent(toks[i], "const") and !lexed.isIdent(toks[i], "let")) continue;
        if (toks[i + 1].kind != .ident) continue;

        const list_name = lexed.text(toks[i + 1]);
        if (!std.mem.endsWith(u8, list_name, "TOOLS") and
            !std.mem.endsWith(u8, list_name, "TOOL_NAMES")) continue;
        if (!lexed.isPunct(toks[i + 2], '=')) continue;

        var j = i + 3;
        while (j < toks.len and
            (lexed.isIdent(toks[j], "new") or lexed.isIdent(toks[j], "Set") or lexed.isPunct(toks[j], '(')))
        {
            j += 1;
        }
        if (j >= toks.len or !lexed.isPunct(toks[j], '[')) continue;

        const end = ts_scan.skipBalanced(lexed, j, '[', ']') orelse toks.len;
        var k = j + 1;
        while (k < end) : (k += 1) {
            if (toks[k].kind != .string) continue;
            const body = stringBody(lexed, toks[k]);
            if (std.mem.endsWith(u8, body, "*")) continue;
            try out.append(alloc, .{
                .name = try alloc.dupe(u8, body),
                .file = try alloc.dupe(u8, rel),
                .line = ts_scan.lineOf(lexed.source, toks[k].start),
                .list = try alloc.dupe(u8, list_name),
            });
        }
    }
}

fn addName(alloc: std.mem.Allocator, into: *std.StringHashMap(void), name: []const u8) !void {
    if (name.len == 0) return;
    const gop = try into.getOrPut(name);
    if (!gop.found_existing) gop.key_ptr.* = try alloc.dupe(u8, name);
}

fn freeKeySet(alloc: std.mem.Allocator, set: *std.StringHashMap(void)) void {
    var it = set.keyIterator();
    while (it.next()) |k| alloc.free(k.*);
    set.deinit();
}

fn containsIdent(lexed: lexer.Lexed, name: []const u8) bool {
    for (lexed.tokens) |t| {
        if (lexed.isIdent(t, name)) return true;
    }
    return false;
}

/// The contents of a string token, without its quotes.
fn stringBody(lexed: lexer.Lexed, token: lexer.Token) []const u8 {
    const raw = lexed.text(token);
    if (raw.len >= 2) return raw[1 .. raw.len - 1];
    return raw;
}

/// Production source only: a tool name listed in a test fixture is not a
/// claim about the shipped policy, so including tests would report names no
/// production list ever mentions.
const isSource = paths.isProductionSource;

const testing = std.testing;

fn lexFor(alloc: std.mem.Allocator, src: []const u8) !lexer.Lexed {
    return lexer.lex(alloc, src);
}

test "collectRegistered reads every shape a tool declares its name in" {
    const alloc = testing.allocator;
    const src =
        \\export const TODO_LIST_TOOL_NAME = 'TodoList' as const;
        \\export class CronCreateTool {
        \\  readonly name = 'CronCreate' as const;
        \\}
        \\export const waitFor = defineTool({ name: 'WaitFor', description: 'x' });
        \\this.contributeTool(IAgentSwarmTool, AgentSwarmTool, { name: 'AgentSwarm', domain: 'swarm' });
        \\registerAgentToolService(ITaskStopTool, TaskStopTool, { name: 'TaskStop', domain: 'agentTask' });
    ;
    const lexed = try lexFor(alloc, src);
    defer lexer.deinit(alloc, lexed);

    var set: std.StringHashMap(void) = .init(alloc);
    defer freeKeySet(alloc, &set);
    try collectRegistered(alloc, lexed, "packages/x/src/tools/thing.ts", &set);

    for ([_][]const u8{ "TodoList", "CronCreate", "WaitFor", "AgentSwarm", "TaskStop" }) |name| {
        try testing.expect(set.contains(name));
    }
    try testing.expectEqual(@as(usize, 5), set.count());
}

test "collectRegistered ignores a local tool-name constant" {
    const alloc = testing.allocator;
    const src =
        \\const AUTH_TOOL_TOOL_NAME = 'authenticate';
        \\const name = qualifyMcpToolName(serverName, AUTH_TOOL_TOOL_NAME);
    ;
    const lexed = try lexFor(alloc, src);
    defer lexer.deinit(alloc, lexed);

    var set: std.StringHashMap(void) = .init(alloc);
    defer freeKeySet(alloc, &set);
    try collectRegistered(alloc, lexed, "packages/x/src/agent/mcp/tools/auth.ts", &set);
    try testing.expectEqual(@as(usize, 0), set.count());
}

test "collectRegistered ignores readonly name outside a tool file" {
    const alloc = testing.allocator;
    const src =
        \\export class SomeService {
        \\  readonly name = 'not-a-tool';
        \\}
    ;
    const lexed = try lexFor(alloc, src);
    defer lexer.deinit(alloc, lexed);

    var set: std.StringHashMap(void) = .init(alloc);
    defer freeKeySet(alloc, &set);
    try collectRegistered(alloc, lexed, "packages/x/src/app/service.ts", &set);
    try testing.expectEqual(@as(usize, 0), set.count());
}

test "collectMentions reads tool lists and skips patterns and prefix tables" {
    const alloc = testing.allocator;
    const src =
        \\const DEFAULT_APPROVE_TOOLS = new Set([
        \\  'Read',
        \\  'SetTodoList',
        \\  ...GITHUB_READONLY_TOOL_NAMES,
        \\]);
        \\const AGENT_TOOLS = ['Bash', 'mcp__*'];
        \\const TOWER_TOOL_NAMES = ['TowerInit'];
        \\const OPENAI_VISION_TOOL_PREFIXES = ['gpt-4o'];
        \\const TOOL_HINT_KEYS = ['path'];
        \\const NOT_A_LIST = ['Read'];
    ;
    const lexed = try lexFor(alloc, src);
    defer lexer.deinit(alloc, lexed);

    // The mentions carry duplicated strings, so the test hands them an arena.
    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    var out: std.ArrayList(Mention) = .empty;
    defer out.deinit(arena.allocator());
    try collectMentions(arena.allocator(), lexed, "packages/x/src/policy.ts", &out);

    try testing.expectEqual(@as(usize, 4), out.items.len);
    try testing.expectEqualStrings("Read", out.items[0].name);
    try testing.expectEqualStrings("DEFAULT_APPROVE_TOOLS", out.items[0].list);
    try testing.expectEqual(@as(u32, 2), out.items[0].line);
    try testing.expectEqualStrings("SetTodoList", out.items[1].name);
    try testing.expectEqualStrings("Bash", out.items[2].name);
    try testing.expectEqualStrings("AGENT_TOOLS", out.items[2].list);
    try testing.expectEqualStrings("TowerInit", out.items[3].name);
    try testing.expectEqualStrings("TOWER_TOOL_NAMES", out.items[3].list);
}

test "isSource keeps package and app sources and drops tests" {
    try testing.expect(isSource("packages/agent-core-v2/src/agent/permissionPolicy/policies/x.ts"));
    try testing.expect(!isSource("packages/agent-core-v2/test/agent/x.ts"));
    try testing.expect(!isSource("scripts/thing.ts"));
    try testing.expect(!isSource("packages/x/src/types.d.ts"));
}
