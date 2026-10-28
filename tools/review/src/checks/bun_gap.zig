const std = @import("std");
const Io = std.Io;

const check = @import("../check.zig");
const fsutil = @import("../fsutil.zig");
const lexer = @import("../lexer.zig");
const paths = @import("../paths.zig");
const report = @import("../report.zig");
const ts_scan = @import("../ts_scan.zig");
const walk = @import("../walk.zig");

/// Node endpoints that Bun does not provide, or provides only as a stub.
///
/// This is the third question in the Bun-native family, and the one that bites
/// hardest: `bun-native` says "Bun has a better call for this", `node-launch`
/// says "do not leave Bun's runtime", and this one says **"Bun does not have
/// this endpoint at all"**. A call here does not degrade — it throws
/// `TypeError: undefined is not a function` or `ERR_NOT_IMPLEMENTED`, often
/// inside an error path nobody exercises until production.
///
/// The gap table is transcribed from Bun's own compatibility page
/// (`D:/kimi/bun/docs/runtime/nodejs-compat.mdx`, "Node.js Compatibility"),
/// which is the authority this repository pins its runtime against. Each entry
/// records what Bun does instead, because the useful part of the finding is the
/// replacement, not the prohibition.
///
/// Two severities, because "missing" and "silently wrong" are different bugs:
///   * `.missing`     — the symbol is absent or a stub. Calling it throws.
///   * `.degraded`    — the symbol exists and returns a plausible-looking wrong
///                      answer. This is worse in practice: the caller believes it.
const Kind = enum { missing, degraded };

const Endpoint = struct {
    /// The module the endpoint belongs to, as written in the import.
    module: []const u8,
    /// The member that is missing or degraded.
    name: []const u8,
    kind: Kind,
    /// What Bun does instead, and the replacement to use.
    note: []const u8,
};

const ENDPOINTS = [_]Endpoint{
    // ── absent exports ─────────────────────────────────────────────────────
    // Verified by enumerating `Object.keys(await import('node:*'))` under both
    // runtimes and diffing. Every name below is present in Node 24 and absent
    // in Bun 1.4.4. Only names with no `_` prefix are listed: the underscore
    // ones (`_http_server.STATUS_CODES`, `net._createServerHandle`) are private
    // internals no application should reach for.
    .{ .module = "node:module", .name = "registerHooks", .kind = .missing, .note = "absent in Bun; use Bun.plugin() for module hooks" },
    .{ .module = "node:module", .name = "stripTypeScriptTypes", .kind = .missing, .note = "absent in Bun; use Bun.Transpiler with loader 'ts'" },
    .{ .module = "node:module", .name = "findPackageJSON", .kind = .missing, .note = "absent in Bun; read package.json through Bun.file()" },
    .{ .module = "node:module", .name = "getSourceMapsSupport", .kind = .missing, .note = "absent in Bun" },
    .{ .module = "node:module", .name = "setSourceMapsSupport", .kind = .missing, .note = "absent in Bun" },
    .{ .module = "node:v8", .name = "queryObjects", .kind = .missing, .note = "absent in Bun" },
    .{ .module = "node:crypto", .name = "encapsulate", .kind = .missing, .note = "absent in Bun; use ML-KEM keys through crypto.subtle" },
    .{ .module = "node:crypto", .name = "decapsulate", .kind = .missing, .note = "absent in Bun; use ML-KEM keys through crypto.subtle" },
    .{ .module = "node:dns", .name = "resolveTlsa", .kind = .missing, .note = "absent in Bun" },
    .{ .module = "node:dns/promises", .name = "resolveTlsa", .kind = .missing, .note = "absent in Bun" },
    .{ .module = "node:domain", .name = "Domain", .kind = .missing, .note = "absent in Bun; domains are deprecated in Node too" },
    .{ .module = "node:util", .name = "diff", .kind = .missing, .note = "absent in Bun (it is re-exported through node:sys as well)" },
    .{ .module = "node:util", .name = "getCallSite", .kind = .missing, .note = "absent in Bun" },
    .{ .module = "node:util", .name = "transferableAbortController", .kind = .missing, .note = "absent in Bun" },
    .{ .module = "node:util", .name = "transferableAbortSignal", .kind = .missing, .note = "absent in Bun" },
    .{ .module = "node:console", .name = "createTask", .kind = .missing, .note = "absent in Bun" },
    .{ .module = "node:inspector", .name = "Network", .kind = .missing, .note = "absent in Bun" },
    .{ .module = "node:inspector/promises", .name = "Network", .kind = .missing, .note = "absent in Bun" },
    .{ .module = "node:worker_threads", .name = "locks", .kind = .missing, .note = "absent in Bun (also absent from navigator)" },

    // ── present but behaviourally wrong ────────────────────────────────────
    // These are the dangerous class and every one was confirmed by running the
    // same probe under Node 24 and Bun 1.4.4, not by reading a compatibility
    // page. Two entries that a docs-only reading would have produced are NOT
    // here, because the probe showed them to be non-gaps:
    //   * `eventLoopUtilization()` also returns all zeros under Node >= 23 —
    //     the counters were never populated there either;
    //   * `executionAsyncId()`/`triggerAsyncId()` also return 0 under Node when
    //     called outside a hook.
    .{ .module = "node:v8", .name = "serialize", .kind = .degraded, .note = "emits JavaScriptCore's wire format, not V8's; the bytes are unreadable by Node and vice versa. Use JSON or a format you own" },
    .{ .module = "node:v8", .name = "deserialize", .kind = .degraded, .note = "reads JavaScriptCore's format only; a V8-produced buffer fails or misparses" },
    .{ .module = "node:v8", .name = "setFlagsFromString", .kind = .degraded, .note = "ignores the flags: `--max-old-space-size=64` leaves heap_size_limit unchanged" },
    .{ .module = "node:v8", .name = "takeCoverage", .kind = .degraded, .note = "throws ERR_NOT_IMPLEMENTED in Bun" },
    .{ .module = "node:v8", .name = "stopCoverage", .kind = .degraded, .note = "throws ERR_NOT_IMPLEMENTED in Bun" },
    .{ .module = "node:v8", .name = "promiseHooks", .kind = .degraded, .note = "the object exists but promiseHooks.createHook() throws ERR_NOT_IMPLEMENTED" },
    .{ .module = "node:async_hooks", .name = "createHook", .kind = .degraded, .note = "hooks are never invoked: the init callback fires 0 times where Node fires it per async resource" },
    .{ .module = "node:crypto", .name = "secureHeapUsed", .kind = .degraded, .note = "returns undefined in Bun; Node returns a usage object" },
    .{ .module = "node:crypto", .name = "setEngine", .kind = .degraded, .note = "throws ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED (BoringSSL)" },
    .{ .module = "node:crypto", .name = "setFips", .kind = .degraded, .note = "is a no-op in Bun (BoringSSL)" },
    .{ .module = "", .name = "navigator.locks", .kind = .missing, .note = "absent from Bun's navigator; Node exposes a LockManager" },
    .{ .module = "", .name = "navigator.language", .kind = .missing, .note = "undefined in Bun; Node returns a locale string" },
};

/// Worker options Bun accepts and then ignores.
///
/// Kept apart from `ENDPOINTS` because the shape to find is an object property,
/// not a call. Verified by running the same worker under both runtimes with
/// real allocation pressure: Node throws ERR_WORKER_OUT_OF_MEMORY at a 16 MB
/// cap, Bun survives the identical load. A probe that only allocates a few
/// million small integers does not cross either limit, so it proves nothing.
const IGNORED_WORKER_OPTIONS = [_]Endpoint{
    .{
        .module = "node:worker_threads",
        .name = "resourceLimits",
        .kind = .degraded,
        .note = "Bun's Worker accepts resourceLimits and ignores it, so a memory cap passes silently uncapped",
    },
    .{
        .module = "node:worker_threads",
        .name = "trackUnmanagedFds",
        .kind = .degraded,
        .note = "Bun's Worker ignores trackUnmanagedFds",
    },
};

const BASELINE_PATH = "tools/review/bun-gap-baseline.txt";

pub fn run(ctx: *check.Context) !void {
    const files = try walk.collectFiles(ctx.alloc, ctx.io, ctx.root_dir, .{
        .skip_dirs = &paths.SKIP_DIRS,
        .suffixes = &.{ ".ts", ".tsx", ".mjs", ".cjs", ".js" },
    });
    defer walk.freeFiles(ctx.alloc, files);

    var baseline = try check.Baseline.load(ctx.alloc, ctx.io, ctx.root_dir, BASELINE_PATH);
    defer baseline.deinit();

    for (files) |rel| {
        if (!paths.isProductionSource(rel)) continue;

        const text = fsutil.readFileAllocOrNull(ctx.alloc, ctx.io, ctx.root_dir, rel) orelse continue;
        defer ctx.alloc.free(text);

        try scanFile(ctx, rel, text, &baseline);
    }

    try baseline.reportStale(ctx, "bun-gap", BASELINE_PATH);
}

fn scanFile(
    ctx: *check.Context,
    rel: []const u8,
    text: []const u8,
    baseline: *check.Baseline,
) !void {
    const lexed = lexer.lex(ctx.alloc, text) catch return;
    defer lexer.deinit(ctx.alloc, lexed);
    if (!lexed.reliable) return;

    // A wholly-missing module is reported once, at its import line, because the
    // import itself is the failure — a member lookup never gets that far.
    for (MISSING_MODULES) |module| {
        const line = importLine(lexed, module) orelse continue;
        const key = try std.fmt.allocPrint(ctx.alloc, "{s}:import:{s}", .{ rel, module });
        if (baseline.get(key) != null) continue;

        try ctx.report.add(.{
            .check = "bun-gap",
            .severity = .err,
            .file = try ctx.alloc.dupe(u8, rel),
            .line = line,
            .message = try std.fmt.allocPrint(
                ctx.alloc,
                "imports {s}, which Bun does not implement at all",
                .{module},
            ),
            .evidence = "use `bun build --compile` for single-file executables, or remove the dependency",
        });
    }

    for (ENDPOINTS) |endpoint| {
        if (endpoint.module.len > 0 and importLine(lexed, endpoint.module) == null) continue;

        const names = try memberNames(ctx.alloc, endpoint.name);
        defer ctx.alloc.free(names);

        const line = firstUseLine(lexed, names) orelse continue;

        const key = try std.fmt.allocPrint(ctx.alloc, "{s}:{s}", .{ rel, endpoint.name });
        if (baseline.get(key) != null) continue;

        const verb = switch (endpoint.kind) {
            .missing => "does not exist in Bun",
            .degraded => "exists in Bun but does not do what it says",
        };
        try ctx.report.add(.{
            .check = "bun-gap",
            .severity = severityFor(endpoint.kind),
            .file = try ctx.alloc.dupe(u8, rel),
            .line = line,
            .message = try std.fmt.allocPrint(
                ctx.alloc,
                "{s} {s}: {s}",
                .{ endpoint.name, verb, endpoint.note },
            ),
            .evidence = try std.fmt.allocPrint(
                ctx.alloc,
                "source: Bun's Node.js Compatibility page ({s}); accept in {s} only if the runtime never reaches this line",
                .{ if (endpoint.module.len > 0) endpoint.module else "global", BASELINE_PATH },
            ),
        });
    }

    // `resourceLimits:` as an object property, which is how a Worker option is
    // written. Matched separately from the ENDPOINTS loop because that loop
    // requires the module to be imported and looks for call-shaped uses.
    for (IGNORED_WORKER_OPTIONS) |opt| {
        if (importLine(lexed, opt.module) == null) continue;
        // A file that already gates the option on the runtime has handled the
        // gap; reporting the guarded form again would punish the fix.
        if (guardsOptionOnRuntime(text, opt.name)) continue;
        const toks = lexed.tokens;
        var found: ?u32 = null;
        var i: usize = 0;
        while (i + 1 < toks.len) : (i += 1) {
            if (!lexed.isIdent(toks[i], opt.name)) continue;
            // `resourceLimits:` (longhand) or `resourceLimits,` / `resourceLimits }`
            // (shorthand, which is how a pre-built options object is passed).
            if (lexed.isPunct(toks[i + 1], ':')) {
                found = ts_scan.lineOf(text, toks[i].start);
                break;
            }
            if (lexed.isPunct(toks[i + 1], ',') or lexed.isPunct(toks[i + 1], '}')) {
                if (isInsideObjectLiteral(lexed, i)) {
                    found = ts_scan.lineOf(text, toks[i].start);
                    break;
                }
            }
        }
        const line = found orelse continue;

        const key = try std.fmt.allocPrint(ctx.alloc, "{s}:{s}", .{ rel, opt.name });
        if (baseline.get(key) != null) continue;

        try ctx.report.add(.{
            .check = "bun-gap",
            .severity = severityFor(opt.kind),
            .file = try ctx.alloc.dupe(u8, rel),
            .line = line,
            .message = try std.fmt.allocPrint(ctx.alloc, "{s}: {s}", .{ opt.name, opt.note }),
            .evidence = try std.fmt.allocPrint(
                ctx.alloc,
                "enforce the limit yourself, or accept in {s} with the reason recorded",
                .{BASELINE_PATH},
            ),
        });
    }
}

/// A wrong answer is worse than an exception, so a degraded endpoint is an
/// error and a missing one is only a warning: the missing call fails loudly the
/// first time it runs, which is the cheap case.
fn severityFor(kind: Kind) report.Severity {
    return switch (kind) {
        .missing => .warn,
        .degraded => .err,
    };
}

/// Whether the identifier at `index` sits inside a `{ … }` object literal, which
/// is what distinguishes the shorthand property `resourceLimits,` from an
/// ordinary variable reference in a function body.
fn isInsideObjectLiteral(lexed: lexer.Lexed, index: usize) bool {
    var depth_brace: usize = 0;
    var i = index;
    while (i > 0) {
        i -= 1;
        if (lexed.isPunct(lexed.tokens[i], '}')) depth_brace += 1;
        if (lexed.isPunct(lexed.tokens[i], '{')) {
            if (depth_brace == 0) return true;
            depth_brace -= 1;
        }
        // A statement boundary before any `{` means this is not an object body.
        if (lexed.isPunct(lexed.tokens[i], ';') and depth_brace == 0) return false;
    }
    return false;
}

/// Whether the file decides whether to pass `name` based on the runtime, which
/// is the correct handling of a Worker option Bun ignores.
///
/// The shapes recognised are the ones this repository actually uses: a ternary
/// on a Bun probe (`typeof Bun === 'undefined' ? { [name] } : {}`) and an
/// explicit `if (RUNTIME_IS_BUN)` branch. Both put the decision in the file that
/// would otherwise be flagged, which is the whole point of the guard.
fn guardsOptionOnRuntime(text: []const u8, name: []const u8) bool {
    const probes = [_][]const u8{ "Bun?: unknown", "typeof Bun", "RUNTIME_IS_BUN", "typeof globalThis" };
    var probes_runtime = false;
    for (probes) |probe| {
        if (std.mem.indexOf(u8, text, probe) != null) {
            probes_runtime = true;
            break;
        }
    }
    if (!probes_runtime) return false;

    // A Bun probe alone is not enough — the option has to sit in a branch that
    // the probe selects. Three shapes, all present in this repository:
    //   * a predicate that returns the options object conditionally
    //     (`? { resourceLimits: limits } : {}`);
    //   * a ternary whose Bun arm builds one Worker and whose other arm builds
    //     another with the option (`RUNTIME_IS_BUN ? new BunWorker(...) : new Worker({ resourceLimits })`);
    //   * an `if (RUNTIME_IS_BUN)` early branch above the option.
    //
    // The cheap test for all three: the option literal has to appear AFTER a
    // runtime probe, since the probe is what decides whether it is used.
    const option_at = firstOptionLiteral(text, name) orelse return false;
    for (probes) |probe| {
        const probe_at = std.mem.indexOf(u8, text, probe) orelse continue;
        if (probe_at < option_at) return true;
    }
    return false;
}

/// Offset of the first `<name>:` or `<name> =` occurrence that is a runtime
/// expression rather than a type annotation.
///
/// A type annotation (`resourceLimits?: { … }`) is a declaration, not a value;
/// counting it found the guard on a line the guard does not actually cover.
fn firstOptionLiteral(text: []const u8, name: []const u8) ?usize {
    var from: usize = 0;
    while (std.mem.indexOfPos(u8, text, from, name)) |at| {
        from = at + name.len;
        // Skip the type-annotation form. Two spellings: `name?: {` and
        // `{ name?: T }`. Neither is a value, and taking either as the option's
        // position made the guard comparison pass the probe by accident.
        if (at >= 1 and text[at - 1] == '?') continue;
        var after = from;
        while (after < text.len and (text[after] == ' ' or text[after] == '\t')) after += 1;
        if (after < text.len and text[after] == '?') continue;
        if (after < text.len and text[after] == ':') return at;
        // `resourceLimits` passed by shorthand is a value too.
        if (after < text.len and (text[after] == ',' or text[after] == '}')) return at;
    }
    return null;
}

/// `navigator.locks` has to be searched as its two tokens; everything else is a
/// single identifier.
fn memberNames(alloc: std.mem.Allocator, name: []const u8) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    errdefer out.deinit(alloc);
    var it = std.mem.splitScalar(u8, name, '.');
    while (it.next()) |part| try out.append(alloc, part);
    return out.toOwnedSlice(alloc);
}

/// The line a module is imported on, or null.
fn importLine(lexed: lexer.Lexed, module: []const u8) ?u32 {
    const toks = lexed.tokens;
    var i: usize = 0;
    while (i + 1 < toks.len) : (i += 1) {
        if (toks[i].kind != .string) continue;
        const raw = lexed.text(toks[i]);
        if (raw.len < 2) continue;
        if (!std.mem.eql(u8, raw[1 .. raw.len - 1], module)) continue;
        // Only count it when the specifier is in an import/require position.
        if (!isImportSpecifier(lexed, i)) continue;
        return ts_scan.lineOf(lexed.source, toks[i].start);
    }
    return null;
}

/// True when the string at `index` is the module of an `import`/`from`/
/// `require(`/`await import(`, so a locale string that happens to equal
/// `node:v8` is not mistaken for an import.
fn isImportSpecifier(lexed: lexer.Lexed, index: usize) bool {
    if (index == 0) return false;
    const toks = lexed.tokens;
    const prev = toks[index - 1];
    if (lexed.isIdent(prev, "from")) return true;

    // `require('node:v8')` / `await import('node:module')`
    if (lexed.isPunct(prev, '(') and index >= 2) {
        if (lexed.isIdent(toks[index - 2], "require")) return true;
        if (lexed.isIdent(toks[index - 2], "import")) return true;
    }

    // `import 'node:v8'` (side-effect import)
    if (lexed.isIdent(prev, "import")) return true;
    return false;
}

/// The first line any of `names` appears on as a standalone reference.
fn firstUseLine(lexed: lexer.Lexed, names: []const []const u8) ?u32 {
    if (names.len == 0) return null;
    const head = names[0];
    const toks = lexed.tokens;
    var i: usize = 0;
    while (i < toks.len) : (i += 1) {
        if (toks[i].kind != .ident) continue;
        if (!std.mem.eql(u8, lexed.text(toks[i]), head)) continue;
        if (names.len == 1) return ts_scan.lineOf(lexed.source, toks[i].start);
        // `navigator.locks` — check the whole dotted chain.
        var matched = true;
        var cursor = i;
        for (names[1..]) |part| {
            if (cursor + 2 >= toks.len or !lexed.isPunct(toks[cursor + 1], '.')) {
                matched = false;
                break;
            }
            if (toks[cursor + 2].kind != .ident) {
                matched = false;
                break;
            }
            if (!std.mem.eql(u8, lexed.text(toks[cursor + 2]), part)) {
                matched = false;
                break;
            }
            cursor += 2;
        }
        if (matched) return ts_scan.lineOf(lexed.source, toks[i].start);
    }
    return null;
}

const testing = std.testing;

/// Join lines with real newlines, so a test fixture does not have to fight
/// Modules `import('node:x')` cannot resolve at all under Bun.
///
/// `node:sea` is the only one: `node:test` and `node:test/reporters` are absent
/// from Bun's `builtinModules` list but `await import('node:test')` succeeds
/// (the in-process API works under `bun test`), so listing them here would
/// report a crash that does not happen.
const MISSING_MODULES = [_][]const u8{"node:sea"};