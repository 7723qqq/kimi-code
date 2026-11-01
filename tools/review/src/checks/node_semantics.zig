const std = @import("std");
const Io = std.Io;

const check = @import("../check.zig");
const fsutil = @import("../fsutil.zig");
const lexer = @import("../lexer.zig");
const paths = @import("../paths.zig");
const pkgjson = @import("../pkgjson.zig");
const ts_scan = @import("../ts_scan.zig");
const walk = @import("../walk.zig");

/// Two questions about the same subject: is this code reaching for the Node.js
/// runtime when Bun already covers it?
///
/// Bun ships its own implementation of the `node:*` modules. That layer is what
/// makes `node:fs` work under `bun` with no Node installed, and it is the floor
/// this repository stands on — not the goal. Where Bun also exposes a native API
/// with the same semantics, the native call is the one to write: it is the path
/// Bun optimises, and the one that keeps working in a compiled single-file
/// binary. That is `bun-native`, a recommendation (`warn`).
///
/// The inverse failure is a `node` process started *by name*. That escapes the
/// layer entirely and runs whatever Node happens to be on `PATH` — the one
/// runtime this repository does not install. `DEVELOP.md`: "no CI job installs
/// Node". Those sites must go through Bun, so that is an error.
///
/// Both carry a per-file ledger. A pairing is reported only when the two calls
/// are semantically the same, which is a judgement made one narrow shape at a
/// time; the ledger is how an accepted difference stays accepted instead of
/// being re-argued on every run.
const NATIVE_BASELINE = "tools/review/bun-native-baseline.txt";
const LAUNCH_BASELINE = "tools/review/node-launch-baseline.txt";

/// A Node API, the Bun native call that replaces it, and the single condition
/// that makes the replacement safe.
///
/// `condition` is not decoration. `readFile(path, 'utf8')` and
/// `Bun.file(path).text()` agree only because the encoding is pinned: drop it
/// and `readFile` returns bytes, so the suggested replacement would silently
/// change the value the caller receives. A pairing is reported only when the
/// source satisfies its condition — a wrong suggestion costs more than a missed
/// one, because the reader acts on it.
const Pairing = struct {
    /// The Node call, as written after its module is imported.
    node: []const u8,
    /// The module the call has to come from for the pairing to hold.
    from: []const u8,
    /// The Bun native call to write instead.
    bun: []const u8,
    /// What makes the two equivalent, shown in the finding.
    condition: []const u8,
};

const PAIRINGS = [_]Pairing{
    .{
        .node = "readFile",
        .from = "node:fs/promises",
        .bun = "Bun.file(path).text()",
        .condition = "the call pins a UTF-8 encoding (without one Node returns bytes) and the file carries no UTF-8 BOM — Bun's text() strips a BOM, Node's readFile keeps it as U+FEFF",
    },
    .{
        .node = "createHash",
        .from = "node:crypto",
        .bun = "Bun.CryptoHasher",
        .condition = "the digest is read as hex, base64, or a Buffer",
    },
    .{
        .node = "fileURLToPath",
        .from = "node:url",
        .bun = "Bun.fileURLToPath(url)",
        .condition = "the URL is a file: URL — both throw ERR_INVALID_FILE_URL_SCHEME otherwise",
    },
};

/// Node calls that have a Bun native lookalike and are deliberately not
/// paired. Each was measured against Bun 1.4.4 and Node 24.9.0 on the same
/// probe, and the file system ones were measured again by
/// `tools/bun-migrate/src/pairings.mjs`, which is where the numbers below
/// come from. A pairing is a promise that the two agree *and* that the swap
/// is worth making, and these fail one of the two.
///
///   * `existsSync` — `Bun.file(path).exists()` answers false for a directory
///     while `existsSync` answers true, and a static check cannot tell a file
///     check from a directory check. Pairing them would propose a change that
///     changes behaviour in exactly the cases that matter.
///   * `createReadStream` / `createWriteStream` — `Bun.file().stream()` and
///     `Bun.file().writer()` are web streams, not Node streams: they carry no
///     `.on('error')`, no `.pipe()`, no range or encoding options, and
///     `node:stream/promises.pipeline` does not accept them.
///   * `appendFile` — Bun has no append: `Bun.write` truncates and
///     `Bun.file().writer()` overwrites.
///   * `setTimeout` from `node:timers/promises` — `Bun.sleep` ignores an
///     AbortSignal, while the Node call rejects with `ABORT_ERR` on abort.
///   * `spawn` / `execFile` — `Bun.spawn` drops `maxBuffer`, `shell` and the
///     callback shape those call sites rely on.
///   * `randomUUID` — `Bun.randomUUIDv7` is a different version of the same
///     idea.
///   * `writeFile` / `unlink` — measured slower than the `node:fs/promises`
///     call they would replace (0.34x–0.78x for `writeFile`, worsening with
///     the payload). Under Bun, `node:fs` is Bun's own implementation, so
///     there is no compatibility layer to escape: the rewrite adds a diff and
///     costs throughput.
///   * `pathToFileURL` — measured no faster than the `node:url` call, and on
///     Windows a rooted path without a drive letter resolves differently:
///     Node resolves it against the current drive and Bun keeps it
///     drive-less.
const NOT_PAIRED = [_][]const u8{
    "existsSync",
    "createReadStream",
    "createWriteStream",
    "appendFile",
    "setTimeout",
    "spawn",
    "spawnSync",
    "execFile",
    "execFileSync",
    "randomUUID",
    "writeFile",
    "unlink",
    "pathToFileURL",
};

/// Paths whose code may not call `Bun.*`, so no native pairing applies.
///
/// This gate is the difference between a useful finding and a broken one.
/// `pi-tui` declares `engines.node >= 22.19.0` and runs on other hosts;
/// `transcript` and `i18n-shared` are the browser-safe layer; the VS Code
/// extension runs in the extension host and its webview. The repository
/// contains zero `Bun.*` calls in any of them, which is the fact this list
/// encodes. They are named rather than inferred: guessing from `engines` finds
/// none of the browser-safe packages, which declare no `engines` at all.
///
/// `apps/vis/web` is named, not `apps/vis`: the server half of that app runs
/// under Bun like every other backend here, and a prefix match on the app
/// directory excluded it along with the browser bundle.
///
/// `packages/product`'s `node/` subtrees are named for the same reason: they
/// are the Node variant of a package that also ships a runtime-agnostic
/// `common/` half, and `packages/product/test/entry-points.test.ts` typechecks
/// them with the `node` types alone — a `Bun.*` call there fails that test.
const NON_BUN_PATHS = [_][]const u8{
    "packages/pi-tui",
    "packages/transcript",
    "packages/i18n-shared",
    "packages/product/src/client-configs/node",
    "packages/product/src/session-rating/node",
    "packages/product/src/shared/node",
    "apps/vscode",
    "apps/kimi-inspect",
    "apps/vis/web",
};

pub fn runNative(ctx: *check.Context) !void {
    const files = try walk.collectFiles(ctx.alloc, ctx.io, ctx.root_dir, .{
        .skip_dirs = &paths.SKIP_DIRS,
        .suffixes = &.{ ".ts", ".tsx", ".mjs", ".cjs", ".js" },
    });
    defer walk.freeFiles(ctx.alloc, files);

    var baseline = try check.Baseline.load(ctx.alloc, ctx.io, ctx.root_dir, NATIVE_BASELINE);
    defer baseline.deinit();

    for (files) |rel| {
        if (!paths.isBunExecutedSource(rel)) continue;
        if (!isBunHosted(rel)) continue;

        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, rel) orelse continue;
        defer ctx.alloc.free(text);

        try reportNativeSites(ctx, rel, text, &baseline);
    }

    try baseline.reportStale(ctx, "bun-native", NATIVE_BASELINE);
}

fn isBunHosted(rel: []const u8) bool {
    for (NON_BUN_PATHS) |prefix| {
        if (std.mem.startsWith(u8, rel, prefix)) return false;
    }
    return true;
}

/// Count each pairing in a file and report what the ledger has not accepted.
///
/// Counted per file and per pairing: a second `readFile` in a file that already
/// had one still pushes the count past what was accepted, so the ledger cannot
/// hide a new call behind an old one.
fn reportNativeSites(
    ctx: *check.Context,
    rel: []const u8,
    text: []const u8,
    baseline: *check.Baseline,
) !void {
    const lexed = lexer.lex(ctx.alloc, text) catch return;
    defer lexer.deinit(ctx.alloc, lexed);
    if (!lexed.reliable) return;

    for (PAIRINGS) |pairing| {
        const count = countPairingCalls(lexed, pairing);
        if (count == 0) continue;

        const key = try std.fmt.allocPrint(ctx.alloc, "{s}:{s}", .{ rel, pairing.node });
        const allowed = if (baseline.get(key)) |value|
            std.fmt.parseInt(u32, value, 10) catch 0
        else
            0;

        if (count <= allowed) {
            if (count < allowed) {
                try ctx.report.add(.{
                    .check = "bun-native",
                    .severity = .info,
                    .file = try ctx.alloc.dupe(u8, rel),
                    .message = try std.fmt.allocPrint(
                        ctx.alloc,
                        "baseline allows {d} call(s) to {s}, found {d}; tighten it",
                        .{ allowed, pairing.node, count },
                    ),
                    .evidence = try std.fmt.allocPrint(ctx.alloc, "edit {s}", .{NATIVE_BASELINE}),
                });
            }
            continue;
        }

        try ctx.report.add(.{
            .check = "bun-native",
            .severity = .warn,
            .file = try ctx.alloc.dupe(u8, rel),
            .message = try std.fmt.allocPrint(
                ctx.alloc,
                "{d} call(s) to {s}; Bun's native {s} covers this (baseline allows {d})",
                .{ count, pairing.node, pairing.bun, allowed },
            ),
            .evidence = try std.fmt.allocPrint(
                ctx.alloc,
                "equivalent when {s}; raise the count in {s} if the Node call is deliberate",
                .{ pairing.condition, NATIVE_BASELINE },
            ),
        });
    }
}

/// The calls a pairing covers in one file.
///
/// Two import shapes reach the same function, and a check that only sees one
/// of them is blind to a third of the tree:
///
///   * `import { readFile } from 'node:fs/promises'` — a bare call.
///   * `import * as fs from 'node:fs/promises'` — a member call, `fs.readFile`.
///
/// The namespace shape was left out on the grounds that under-reporting is the
/// safe direction. That is true of a *wrong* finding and false of a *missing*
/// one: `packages/kosong/src/providers/kimi-files.ts` imports `node:fs` as a
/// namespace and calls `fs.existsSync` and `fs.promises.readFile` through it,
/// so the check saw nothing there at all.
fn countPairingCalls(lexed: lexer.Lexed, pairing: Pairing) u32 {
    const toks = lexed.tokens;
    var count: u32 = 0;

    var i: usize = 0;
    while (i + 1 < toks.len) : (i += 1) {
        if (!lexed.isIdent(toks[i], "from")) continue;
        const t = toks[i + 1];
        if (t.kind != .string) continue;
        const raw = lexed.text(t);
        if (raw.len < 2) continue;
        if (!std.mem.eql(u8, raw[1 .. raw.len - 1], pairing.from)) continue;

        if (namedImportContains(lexed, i, pairing.node)) {
            count += countBareCalls(lexed, pairing.node);
        }
        if (namespaceAliasBefore(lexed, i)) |alias| {
            count += countMemberCalls(lexed, alias, pairing.node);
        }
    }
    return count;
}

/// `import { readFile } from 'node:fs/promises'`.
///
/// The symbol has to be named in the import: a module can export a function
/// the pairing does not cover, and counting every call to that name in the
/// file would report a pairing the file never opted into.
fn importsSymbol(lexed: lexer.Lexed, module: []const u8, symbol: []const u8) bool {
    const toks = lexed.tokens;
    var i: usize = 0;
    while (i + 1 < toks.len) : (i += 1) {
        if (!lexed.isIdent(toks[i], "from")) continue;
        const t = toks[i + 1];
        if (t.kind != .string) continue;
        const raw = lexed.text(t);
        if (raw.len < 2) continue;
        if (!std.mem.eql(u8, raw[1 .. raw.len - 1], module)) continue;
        if (namedImportContains(lexed, i, symbol)) return true;
    }
    return false;
}

/// Whether the braced import list that ends just before `from_index` names
/// `symbol`.
///
/// The braces are found by walking back from the `}` and matching depth, so a
/// list that spans several lines is read the same way as a one-line one.
fn namedImportContains(lexed: lexer.Lexed, from_index: usize, symbol: []const u8) bool {
    const toks = lexed.tokens;
    if (from_index == 0) return false;
    const close = from_index - 1;
    if (!lexed.isPunct(toks[close], '}')) return false;

    var depth: usize = 0;
    var k = close;
    while (k > 0) {
        if (lexed.isPunct(toks[k], '}')) depth += 1;
        if (lexed.isPunct(toks[k], '{')) {
            depth -= 1;
            if (depth == 0) break;
        }
        k -= 1;
    }
    if (k == 0) return false;

    var j = k + 1;
    while (j < close) : (j += 1) {
        if (lexed.isIdent(toks[j], symbol)) return true;
    }
    return false;
}

/// The local name a namespace import binds: `import * as fs from 'node:fs'`.
///
/// The alias is read off the tokens in front of the `from`, so the result
/// borrows the source and needs no allocation.
fn namespaceAliasBefore(lexed: lexer.Lexed, from_index: usize) ?[]const u8 {
    if (from_index < 3) return null;
    const toks = lexed.tokens;
    const alias = toks[from_index - 1];
    if (alias.kind != .ident) return null;
    if (!lexed.isIdent(toks[from_index - 2], "as")) return null;
    if (!lexed.isPunct(toks[from_index - 3], '*')) return null;
    return lexed.text(alias);
}

/// Occurrences of `name(` — a call, not a mention.
fn countBareCalls(lexed: lexer.Lexed, name: []const u8) u32 {
    const toks = lexed.tokens;
    var count: u32 = 0;
    var i: usize = 0;
    while (i + 1 < toks.len) : (i += 1) {
        if (!lexed.isIdent(toks[i], name)) continue;
        if (!lexed.isPunct(toks[i + 1], '(')) continue;
        // A property access is a different function: `fs.readFile` and
        // `this.readFile` are not the imported binding.
        if (i > 0 and lexed.isPunct(toks[i - 1], '.')) continue;
        count += 1;
    }
    return count;
}

/// Occurrences of `alias.member(` — the namespace import's call shape.
fn countMemberCalls(lexed: lexer.Lexed, alias: []const u8, member: []const u8) u32 {
    const toks = lexed.tokens;
    var count: u32 = 0;
    var i: usize = 0;
    while (i + 3 < toks.len) : (i += 1) {
        if (!lexed.isIdent(toks[i], alias)) continue;
        if (!lexed.isPunct(toks[i + 1], '.')) continue;
        if (!lexed.isIdent(toks[i + 2], member)) continue;
        if (!lexed.isPunct(toks[i + 3], '(')) continue;
        count += 1;
    }
    return count;
}

pub fn runNodeLaunch(ctx: *check.Context) !void {
    var baseline = try check.Baseline.load(ctx.alloc, ctx.io, ctx.root_dir, LAUNCH_BASELINE);
    defer baseline.deinit();

    const files = try walk.collectFiles(ctx.alloc, ctx.io, ctx.root_dir, .{
        .skip_dirs = &paths.SKIP_DIRS,
        .suffixes = &.{ ".ts", ".tsx", ".mjs", ".cjs", ".js" },
    });
    defer walk.freeFiles(ctx.alloc, files);

    for (files) |rel| {
        if (!paths.isProductionSource(rel)) continue;

        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, rel) orelse continue;
        defer ctx.alloc.free(text);

        try reportNodeLiteral(ctx, rel, text, &baseline);
    }

    try scanManifests(ctx, &baseline);

    try baseline.reportStale(ctx, "node-launch", LAUNCH_BASELINE);
}

/// A `node` process started by name from TypeScript or JavaScript.
///
/// Scoped to the one shape that actually starts a process: the literal has to
/// sit in the argv position of a spawn/exec call —
/// `Bun.spawn(['node', …])`, `spawnSync({ cmd: ['node', …] })`,
/// `execFile('node', …)`, or the `command:` field of a process descriptor.
///
/// A bare string comparison was tried first and reported every place the word
/// `node` appears as data: `runtime: isBunRuntime() ? 'bun' : 'node'` in the
/// telemetry payload, `if (config.command === 'node')` in the plugin runtime,
/// and even a locale file's `node: 'node'` label. Those are facts *about* Node,
/// not launches of it — flagging them would teach a reader to ignore the check.
///
/// `environmentProbe.ts` names `node` on purpose: it discovers which runtimes a
/// host has installed so `/status` can report them. That is a probe, not a
/// launch, and it keeps its own baseline entry.
fn reportNodeLiteral(
    ctx: *check.Context,
    rel: []const u8,
    text: []const u8,
    baseline: *check.Baseline,
) !void {
    const lexed = lexer.lex(ctx.alloc, text) catch return;
    defer lexer.deinit(ctx.alloc, lexed);
    if (!lexed.reliable) return;

    var lines: std.ArrayList(u32) = .empty;
    defer lines.deinit(ctx.alloc);

    for (lexed.tokens, 0..) |token, i| {
        if (token.kind != .string) continue;
        const raw = lexed.text(token);
        if (raw.len < 2) continue;
        const value = raw[1 .. raw.len - 1];
        if (!isNodeBinaryName(value)) continue;
        if (!isLaunchPosition(lexed, i)) continue;
        try lines.append(ctx.alloc, ts_scan.lineOf(text, token.start));
    }
    if (lines.items.len == 0) return;

    const count: u32 = @intCast(lines.items.len);
    const allowed = if (baseline.get(rel)) |value|
        std.fmt.parseInt(u32, value, 10) catch 0
    else
        0;
    if (count <= allowed) {
        if (count < allowed) {
            try ctx.report.add(.{
                .check = "node-launch",
                .severity = .info,
                .file = try ctx.alloc.dupe(u8, rel),
                .message = try std.fmt.allocPrint(
                    ctx.alloc,
                    "baseline allows {d} launch(es), found {d}; tighten it",
                    .{ allowed, count },
                ),
                .evidence = try std.fmt.allocPrint(ctx.alloc, "edit {s}", .{LAUNCH_BASELINE}),
            });
        }
        return;
    }

    try ctx.report.add(.{
        .check = "node-launch",
        .severity = .err,
        .file = try ctx.alloc.dupe(u8, rel),
        .message = try std.fmt.allocPrint(
            ctx.alloc,
            "{d} 'node' process launch(es), baseline allows {d}",
            .{ count, allowed },
        ),
        .evidence = try std.fmt.allocPrint(
            ctx.alloc,
            "lines {s}; run that script with `bun <path>` so Bun's own node layer serves it instead of an installed Node. Raise the count in {s} only if the real Node binary is required",
            .{ try lineList(ctx.alloc, lines.items), LAUNCH_BASELINE },
        ),
    });
}

fn isNodeBinaryName(value: []const u8) bool {
    return std.mem.eql(u8, value, "node") or std.mem.eql(u8, value, "node.exe");
}

/// Whether the string token at `index` is in the argv position of a launch.
///
/// Four shapes, each read backwards from the literal:
///   `spawn(['node', …])`      — first element of an array literal whose own
///                               predecessor is `(` after a spawn/exec name;
///   `spawn({ cmd: ['node'…]})`— covered by the array rule as well;
///   `execFile('node', …)`     — first argument of a spawn-family call;
///   `command: 'node'`         — a process descriptor's command field.
fn isLaunchPosition(lexed: lexer.Lexed, index: usize) bool {
    if (index == 0) return false;
    const toks = lexed.tokens;

    // `command: 'node'` / `cmd: 'node'` in an object literal.
    if (lexed.isPunct(toks[index - 1], ':')) {
        if (index >= 2 and toks[index - 2].kind == .ident) {
            const key = lexed.text(toks[index - 2]);
            if (std.mem.eql(u8, key, "command") or std.mem.eql(u8, key, "cmd")) return true;
        }
        return false;
    }

    // First element of an argv array: `[ 'node', ... ]`.
    if (lexed.isPunct(toks[index - 1], '[')) {
        return arrayIsSpawnArgv(lexed, index - 1);
    }

    // First argument of a call: `spawn('node', ...)` / `execFile('node', ...)`.
    if (lexed.isPunct(toks[index - 1], '(')) {
        return callIsSpawnFamily(lexed, index - 1);
    }

    return false;
}

/// Whether the `[` at `open` starts an argv array handed to a spawn-family call.
fn arrayIsSpawnArgv(lexed: lexer.Lexed, open: usize) bool {
    if (open == 0) return false;
    const prev = open - 1;
    // `spawn([...])`, `execFile([...])`, `Bun.spawn([...])`.
    if (lexed.isPunct(lexed.tokens[prev], '(')) return callIsSpawnFamily(lexed, prev);
    // `cmd: [...]` / `command: [...]` inside a spawn options object.
    if (lexed.isPunct(lexed.tokens[prev], ':')) {
        if (prev >= 1 and lexed.tokens[prev - 1].kind == .ident) {
            const key = lexed.text(lexed.tokens[prev - 1]);
            return std.mem.eql(u8, key, "cmd") or std.mem.eql(u8, key, "command");
        }
    }
    return false;
}

/// Whether the `(` at `open` belongs to a spawn-family call.
fn callIsSpawnFamily(lexed: lexer.Lexed, open: usize) bool {
    if (open == 0) return false;
    const toks = lexed.tokens;
    const name_index = open - 1;
    if (toks[name_index].kind != .ident) return false;
    const name = lexed.text(toks[name_index]);
    return std.mem.eql(u8, name, "spawn") or
        std.mem.eql(u8, name, "spawnSync") or
        std.mem.eql(u8, name, "execFile") or
        std.mem.eql(u8, name, "execFileSync");
}

/// A `node` launch written outside TypeScript: workspace package scripts, the
/// Windows launchers, and the Nix build.
///
/// A package.json is parsed rather than scanned, because a script body and a
/// `"description": "node types"` field are one quote apart and a text scan
/// cannot tell them apart.
fn scanManifests(ctx: *check.Context, baseline: *check.Baseline) !void {
    const manifests = try collectManifests(ctx);
    defer {
        for (manifests) |m| ctx.alloc.free(m);
        ctx.alloc.free(manifests);
    }

    for (manifests) |rel| {
        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, rel) orelse continue;
        defer ctx.alloc.free(text);

        const sites = try countLaunchSites(ctx, rel, text);
        if (sites.count == 0) continue;

        const key = try std.fmt.allocPrint(ctx.alloc, "{s}:launch", .{rel});
        if (baseline.get(key) != null) continue;

        try ctx.report.add(.{
            .check = "node-launch",
            .severity = .err,
            .file = try ctx.alloc.dupe(u8, rel),
            .line = sites.first_line,
            .message = try std.fmt.allocPrint(
                ctx.alloc,
                "{d} command(s) start Node by name",
                .{sites.count},
            ),
            .evidence = try std.fmt.allocPrint(
                ctx.alloc,
                "invoke the script with `bun` instead — Bun serves node:* itself, so the Node install this repository does not ship is not needed. Accept the site in {s} where Node is a genuine requirement",
                .{LAUNCH_BASELINE},
            ),
        });
    }
}

const LaunchSites = struct { count: u32, first_line: u32 };

fn countLaunchSites(ctx: *check.Context, rel: []const u8, text: []const u8) !LaunchSites {
    if (std.mem.endsWith(u8, rel, ".json")) return countJsonScriptSites(ctx, text);

    var sites: LaunchSites = .{ .count = 0, .first_line = 0 };
    var line_no: u32 = 0;
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        line_no += 1;
        if (!startsNodeCommand(line)) continue;
        sites.count += 1;
        if (sites.first_line == 0) sites.first_line = line_no;
    }
    return sites;
}

fn countJsonScriptSites(ctx: *check.Context, text: []const u8) !LaunchSites {
    var parsed = std.json.parseFromSlice(std.json.Value, ctx.alloc, text, .{}) catch
        return .{ .count = 0, .first_line = 0 };
    defer parsed.deinit();

    const root = switch (parsed.value) {
        .object => |o| o,
        else => return .{ .count = 0, .first_line = 0 },
    };
    const scripts = switch (root.get("scripts") orelse return .{ .count = 0, .first_line = 0 }) {
        .object => |o| o,
        else => return .{ .count = 0, .first_line = 0 },
    };

    var sites: LaunchSites = .{ .count = 0, .first_line = 0 };
    var it = scripts.iterator();
    while (it.next()) |entry| {
        const body = switch (entry.value_ptr.*) {
            .string => |s| s,
            else => continue,
        };
        var found: u32 = 0;
        var cursor: usize = 0;
        while (cursor < body.len) {
            if (isCommandStart(body, cursor) and startsWithNodeToken(body[cursor..])) found += 1;
            cursor += 1;
        }
        if (found == 0) continue;
        sites.count += found;
        if (sites.first_line == 0) {
            sites.first_line = try findLineOfScript(text, entry.key_ptr.*);
        }
    }
    return sites;
}

/// Locate a script key in the raw text so the finding points at a line. Best
/// effort: a miss reports line 0, which still names the file.
fn findLineOfScript(text: []const u8, name: []const u8) !u32 {
    var line_no: u32 = 1;
    var i: usize = 0;
    while (i < text.len) : (i += 1) {
        if (text[i] == '\n') line_no += 1;
        if (text[i] != '"') continue;
        if (i + name.len + 2 > text.len) break;
        if (!std.mem.eql(u8, text[i + 1 .. i + 1 + name.len], name)) continue;
        if (text[i + 1 + name.len] != '"') continue;
        return line_no;
    }
    return 0;
}

/// One finding per text manifest, so each names its own file and line.
fn collectManifests(ctx: *check.Context) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    errdefer out.deinit(ctx.alloc);

    const fixed = [_][]const u8{
        "Makefile",
        "bunfig.toml",
        "start-native.bat",
        "start-desktop.bat",
        "deploy-local.cmd",
        "flake.nix",
    };
    for (fixed) |rel| {
        if (fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, rel) == null) continue;
        try out.append(ctx.alloc, try ctx.alloc.dupe(u8, rel));
    }

    const files = try walk.collectFiles(ctx.alloc, ctx.io, ctx.root_dir, .{
        .skip_dirs = &paths.SKIP_DIRS,
        .suffixes = &.{"package.json"},
    });
    defer walk.freeFiles(ctx.alloc, files);
    for (files) |rel| {
        if (!paths.isPackageOrApp(rel)) continue;
        try out.append(ctx.alloc, try ctx.alloc.dupe(u8, rel));
    }
    return out.toOwnedSlice(ctx.alloc);
}

/// Whether a line runs `node` as a command: at the start, or after a shell
/// separator, or as a workflow `run:` body.
///
/// A substring search would match `# node is not required` and
/// `nodejs = nodejsFor pkgs`, so the token has to be in command position — and
/// a `node = value` binding is an assignment, not a launch, which is why the
/// separator set below deliberately omits `=`.
fn startsNodeCommand(line: []const u8) bool {
    const trimmed = trimStart(line, " \t");
    if (trimmed.len == 0 or trimmed[0] == '#') return false;

    var rest = trimmed;
    // `run: node x.mjs` and `- run: node x.mjs`
    if (std.mem.startsWith(u8, rest, "- ")) rest = trimStart(rest[2..], " \t");
    if (std.mem.startsWith(u8, rest, "run:")) rest = trimStart(rest[4..], " \t");

    var cursor: usize = 0;
    while (cursor < rest.len) {
        if (isCommandStart(rest, cursor) and startsWithNodeToken(rest[cursor..])) {
            return !isAssignment(rest, cursor);
        }
        cursor += 1;
    }
    return false;
}

/// `node = pkgs.nodejs_24` binds a Nix variable; `node x.mjs` runs a command.
///
/// The two are one character apart and both appear in `flake.nix`, so the
/// difference has to be read rather than assumed.
fn isAssignment(text: []const u8, at: usize) bool {
    var i = at + "node".len;
    while (i < text.len and (text[i] == ' ' or text[i] == '\t')) i += 1;
    return i < text.len and text[i] == '=' and (i + 1 >= text.len or text[i + 1] != '=');
}

/// True at offset 0 and after an unquoted shell separator, so `a && node b`
/// and `"build": "x && node y"` both expose their `node`.
fn isCommandStart(text: []const u8, at: usize) bool {
    if (at == 0) return true;
    var i = at;
    while (i > 0) {
        i -= 1;
        switch (text[i]) {
            ' ', '\t', '"', '\'' => continue,
            '&', '|', ';', '(', ':', ',' => return true,
            else => return false,
        }
    }
    return true;
}

/// `node` followed by something to run. A bare `node` on its own is a value
/// reference — `then\n  node` is a Nix conditional's result, not a launch.
fn startsWithNodeToken(rest: []const u8) bool {
    var after: usize = 0;
    if (std.mem.startsWith(u8, rest, "node.exe")) {
        after = "node.exe".len;
    } else if (std.mem.startsWith(u8, rest, "node")) {
        after = "node".len;
    } else return false;

    if (after >= rest.len) return false;
    const next = rest[after];
    return next == ' ' or next == '\t';
}

/// `std.mem.trimLeft` does not exist in Zig 0.17; `trim` needs both ends.
fn trimStart(text: []const u8, set: []const u8) []const u8 {
    var i: usize = 0;
    while (i < text.len and std.mem.indexOfScalar(u8, set, text[i]) != null) i += 1;
    return text[i..];
}

/// "12,45,78" — the lines a file's launches sit on, for the evidence line.
fn lineList(alloc: std.mem.Allocator, lines: []const u32) ![]const u8 {
    if (lines.len == 0) return alloc.dupe(u8, "");
    const buf = try alloc.alloc(u8, lines.len * 12);
    errdefer alloc.free(buf);
    var n: usize = 0;
    for (lines, 0..) |line, i| {
        if (i > 0) {
            buf[n] = ',';
            n += 1;
        }
        const written = try std.fmt.bufPrint(buf[n..], "{d}", .{line});
        n += written.len;
    }
    return try alloc.realloc(buf, n);
}

const testing = std.testing;

fn lexFor(alloc: std.mem.Allocator, src: []const u8) !lexer.Lexed {
    return lexer.lex(alloc, src);
}

/// Whether `isLaunchPosition` fires for any `node` literal in the snippet.
fn scanHasLaunch(alloc: std.mem.Allocator, src: []const u8) bool {
    const lexed = lexer.lex(alloc, src) catch return false;
    defer lexer.deinit(alloc, lexed);

    for (lexed.tokens, 0..) |token, i| {
        if (token.kind != .string) continue;
        const raw = lexed.text(token);
        if (raw.len < 2) continue;
        if (!isNodeBinaryName(raw[1 .. raw.len - 1])) continue;
        if (isLaunchPosition(lexed, i)) return true;
    }
    return false;
}

test "countBareCalls counts calls and ignores property accesses and mentions" {
    const alloc = testing.allocator;
    const src =
        \\const a = readFile(p, 'utf8');
        \\const b = fs.readFile(q, 'utf8');
        \\// readFile mentions do not count
        \\const c = readFile(r, 'utf8');
    ;
    const lexed = try lexFor(alloc, src);
    defer lexer.deinit(alloc, lexed);

    try testing.expectEqual(@as(u32, 2), countBareCalls(lexed, "readFile"));
}

test "importsSymbol matches a named import and rejects a different module" {
    const alloc = testing.allocator;
    const src =
        \\import { readFile } from 'node:fs/promises';
        \\const x = 1;
    ;
    const lexed = try lexFor(alloc, src);
    defer lexer.deinit(alloc, lexed);

    try testing.expect(importsSymbol(lexed, "node:fs/promises", "readFile"));
    try testing.expect(!importsSymbol(lexed, "node:fs", "readFile"));
    try testing.expect(!importsSymbol(lexed, "node:fs/promises", "writeFile"));
}

test "importsSymbol reads a multi-line import list" {
    const alloc = testing.allocator;
    const src =
        \\import {
        \\  readFile,
        \\  writeFile,
        \\} from 'node:fs/promises';
    ;
    const lexed = try lexFor(alloc, src);
    defer lexer.deinit(alloc, lexed);

    try testing.expect(importsSymbol(lexed, "node:fs/promises", "readFile"));
    try testing.expect(importsSymbol(lexed, "node:fs/promises", "writeFile"));
    try testing.expect(!importsSymbol(lexed, "node:fs/promises", "unlink"));
}

test "a namespace import is matched by its member calls" {
    const alloc = testing.allocator;
    const src =
        \\import * as fs from 'node:fs/promises';
        \\const a = fs.readFile(p, 'utf8');
        \\const b = fs.readFile(q, 'utf8');
        \\const c = fs.stat(p);
    ;
    const lexed = try lexFor(alloc, src);
    defer lexer.deinit(alloc, lexed);

    const pairing = Pairing{
        .node = "readFile",
        .from = "node:fs/promises",
        .bun = "Bun.file(path).text()",
        .condition = "unused in this test",
    };
    try testing.expectEqual(@as(u32, 2), countPairingCalls(lexed, pairing));
}

test "a named import and a namespace import of the same module both count" {
    const alloc = testing.allocator;
    const src =
        \\import { readFile } from 'node:fs/promises';
        \\import * as fs from 'node:fs/promises';
        \\const a = readFile(p, 'utf8');
        \\const b = fs.readFile(q, 'utf8');
    ;
    const lexed = try lexFor(alloc, src);
    defer lexer.deinit(alloc, lexed);

    const pairing = Pairing{
        .node = "readFile",
        .from = "node:fs/promises",
        .bun = "Bun.file(path).text()",
        .condition = "unused in this test",
    };
    try testing.expectEqual(@as(u32, 2), countPairingCalls(lexed, pairing));
}

test "a module that does not export the symbol contributes nothing" {
    const alloc = testing.allocator;
    const src =
        \\import { writeFile } from 'node:fs/promises';
        \\const a = readFile(p, 'utf8');
    ;
    const lexed = try lexFor(alloc, src);
    defer lexer.deinit(alloc, lexed);

    const pairing = Pairing{
        .node = "readFile",
        .from = "node:fs/promises",
        .bun = "Bun.file(path).text()",
        .condition = "unused in this test",
    };
    try testing.expectEqual(@as(u32, 0), countPairingCalls(lexed, pairing));
}

test "isBunHosted excludes the Node-only and browser-safe packages" {
    try testing.expect(isBunHosted("packages/agent-core-v2/src/x.ts"));
    try testing.expect(isBunHosted("apps/kimi-code/src/x.ts"));
    try testing.expect(isBunHosted("apps/vis/server/src/x.ts"));

    try testing.expect(!isBunHosted("packages/pi-tui/src/x.ts"));
    try testing.expect(!isBunHosted("packages/transcript/src/x.ts"));
    try testing.expect(!isBunHosted("packages/i18n-shared/src/x.ts"));
    try testing.expect(!isBunHosted("apps/vscode/src/x.ts"));
    try testing.expect(!isBunHosted("apps/vis/web/src/x.tsx"));
}

test "a Node call with a Bun lookalike that disagrees stays unpaired" {
    // Each entry in NOT_PAIRED was measured against Bun 1.4.4 and Node 24.9.0.
    // The list is only worth keeping if none of them quietly becomes a
    // pairing, so the two lists are checked against each other here.
    for (NOT_PAIRED) |name| {
        for (PAIRINGS) |pairing| {
            try testing.expect(!std.mem.eql(u8, name, pairing.node));
        }
    }
}

test "startsNodeCommand accepts the forms a launcher uses" {
    try testing.expect(startsNodeCommand("node scripts/x.mjs"));
    try testing.expect(startsNodeCommand("  node scripts/x.mjs"));
    try testing.expect(startsNodeCommand("a && node b.mjs"));
    try testing.expect(startsNodeCommand("- run: node x.mjs"));
    try testing.expect(startsNodeCommand("run: node x.mjs"));
    try testing.expect(startsNodeCommand("node.exe x.mjs"));
}

test "startsNodeCommand rejects mentions that are not commands" {
    try testing.expect(!startsNodeCommand("  # node is not required here"));
    try testing.expect(!startsNodeCommand("node_modules/x.js"));
    try testing.expect(!startsNodeCommand("nodejs = nodejsFor pkgs;"));
    try testing.expect(!startsNodeCommand("bun node x.mjs"));
    try testing.expect(!startsNodeCommand(""));
}

test "startsNodeCommand rejects a Nix or shell variable binding" {
    // The exact line that was reported before the assignment guard.
    try testing.expect(!startsNodeCommand("          node = pkgs.nodejs_24;"));
    try testing.expect(!startsNodeCommand("node=pkgs.nodejs_24"));
    // A Nix conditional's result is a value, not a launch.
    try testing.expect(!startsNodeCommand("          node"));
    // A real launch on the same file still reports.
    try testing.expect(startsNodeCommand("              node apps/kimi-code/scripts/check.mjs"));
}

test "isLaunchPosition accepts the spawn argv shapes" {
    const alloc = testing.allocator;
    // Bun.spawn(['node', …])
    try testing.expect(scanHasLaunch(alloc, "Bun.spawn(['node', '-e', 'x']);"));
    // Bun.spawn({ cmd: ['node', …] })
    try testing.expect(scanHasLaunch(alloc, "Bun.spawn({ cmd: ['node', 'x.mjs'] });"));
    // execFile('node', […])
    try testing.expect(scanHasLaunch(alloc, "execFile('node', ['x.mjs']);"));
    // a process descriptor's command field
    try testing.expect(scanHasLaunch(alloc, "const d = { command: 'node', args: [] };"));
}

test "isLaunchPosition rejects the word node used as data" {
    const alloc = testing.allocator;
    // The three false positives the first implementation produced.
    try testing.expect(!scanHasLaunch(alloc, "runtime: isBunRuntime() ? 'bun' : 'node',"));
    try testing.expect(!scanHasLaunch(alloc, "if (config.command === 'node') {}"));
    try testing.expect(!scanHasLaunch(alloc, "node: 'node',"));
    // A probe that discovers an installed runtime is a read, not a launch.
    try testing.expect(!scanHasLaunch(alloc, "const b = { name: 'node', binary: 'node.exe' };"));
}

test "countJsonScriptSites reads a script body and ignores other fields" {
    const alloc = testing.allocator;

    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    var rep = @import("../report.zig").Report.init(arena.allocator());
    defer rep.deinit();
    var ctx = check.Context{
        .alloc = arena.allocator(),
        .io = testing.io,
        .root_dir = Io.Dir.cwd(),
        .report = &rep,
    };

    // The description mentions node but is not a command.
    const json =
        \\{
        \\  "description": "node types and a node_modules note",
        \\  "scripts": {
        \\    "build": "bun run deps && node scripts/copy.mjs",
        \\    "check": "bun scripts/check.mjs"
        \\  }
        \\}
    ;
    const sites = try countJsonScriptSites(&ctx, json);
    try testing.expectEqual(@as(u32, 1), sites.count);
}

test "countJsonScriptSites finds the line of the script it blames" {
    const alloc = testing.allocator;
    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    var rep = @import("../report.zig").Report.init(arena.allocator());
    defer rep.deinit();
    var ctx = check.Context{
        .alloc = arena.allocator(),
        .io = testing.io,
        .root_dir = Io.Dir.cwd(),
        .report = &rep,
    };

    const json =
        \\{
        \\  "scripts": {
        \\    "build": "node x.mjs"
        \\  }
        \\}
    ;
    const sites = try countJsonScriptSites(&ctx, json);
    try testing.expectEqual(@as(u32, 1), sites.count);
    try testing.expectEqual(@as(u32, 3), sites.first_line);
}

test "lineList joins line numbers and survives an empty list" {
    const alloc = testing.allocator;
    const lines = [_]u32{ 12, 45, 7 };
    const list = try lineList(alloc, &lines);
    defer alloc.free(list);
    try testing.expectEqualStrings("12,45,7", list);

    const empty = try lineList(alloc, &.{});
    defer alloc.free(empty);
    try testing.expectEqualStrings("", empty);
}
