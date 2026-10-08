const std = @import("std");
const Io = std.Io;

const check = @import("check.zig");
const report = @import("report.zig");
const checks = @import("checks.zig");

// Zig only runs tests from files the test build actually analyzes, and a
// top-level `const x = @import(...)` is analyzed lazily. Naming a module here is
// what makes `zig build test` cover it rather than just this file; every module
// under `src/` is listed except `probe_main.zig`, whose only job is to be run by
// hand against `workflow_triggers`. A new module belongs in this list.
test {
    _ = @import("check.zig");
    _ = @import("fsutil.zig");
    _ = @import("lexer.zig");
    _ = @import("pkgjson.zig");
    _ = @import("proc.zig");
    _ = @import("report.zig");
    _ = @import("ts_scan.zig");
    _ = @import("walk.zig");
    _ = @import("workflow.zig");
    _ = @import("checks.zig");
    _ = @import("checks/ci_coverage.zig");
    _ = @import("checks/dangling_refs.zig");
    _ = @import("checks/gate_wiring.zig");
    _ = @import("checks/orphan_exports.zig");
    _ = @import("checks/silent_catch.zig");
    _ = @import("checks/stale_artifacts.zig");
    _ = @import("checks/upstream_drift.zig");
    _ = @import("checks/workflow_triggers.zig");
    _ = @import("checks/scripts_wiring.zig");
}

pub const VERSION = "0.1.0";

const USAGE =
    \\review {s} — structural review checks for the kimi-code monorepo
    \\
    \\These checks cover defects that the test suite cannot see: exported functions
    \\only their own test calls, tool names a list mentions but nothing registers,
    \\documented gates that were never wired up, workspace members missing from CI,
    \\and generated artifacts that drifted from their source.
    \\
    \\Usage:
    \\  review [options]
    \\
    \\Options:
    \\  --list                 List every check and exit
    \\  --check=<a,b>          Run only the named checks
    \\  --json                 Emit findings as JSON instead of text
    \\  --root=<path>          Repository root to analyse (default: .)
    \\  --version              Print the version and exit
    \\  --help                 Print this message
    \\
    \\Exit code is 0 when no error-severity finding was reported, 1 otherwise.
    \\
;

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const io = init.io;
    const args = try init.minimal.args.toSlice(arena);

    var stdout_buffer: [8192]u8 = undefined;
    var stdout_file_writer: Io.File.Writer = .init(.stdout(), io, &stdout_buffer);
    const out = &stdout_file_writer.interface;

    var stderr_buffer: [4096]u8 = undefined;
    var stderr_file_writer: Io.File.Writer = .init(.stderr(), io, &stderr_buffer);
    const err_out = &stderr_file_writer.interface;

    var opts: Options = .{};
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            try out.print(USAGE, .{VERSION});
            try out.flush();
            return;
        } else if (std.mem.eql(u8, arg, "--version")) {
            try out.print("review {s}\n", .{VERSION});
            try out.flush();
            return;
        } else if (std.mem.eql(u8, arg, "--list")) {
            opts.list = true;
        } else if (std.mem.eql(u8, arg, "--json")) {
            opts.json = true;
        } else if (std.mem.startsWith(u8, arg, "--check=")) {
            opts.only = arg["--check=".len..];
        } else if (std.mem.startsWith(u8, arg, "--root=")) {
            opts.root = arg["--root=".len..];
        } else {
            try err_out.print("review: unknown argument '{s}'\n\n", .{arg});
            try err_out.print(USAGE, .{VERSION});
            try err_out.flush();
            std.process.exit(2);
        }
    }

    if (opts.list) {
        for (checks.all) |c| {
            try out.print("{s: <18} {s: <6} {s}\n", .{ c.name, c.severity.label(), c.description });
        }
        try out.flush();
        return;
    }

    var rep = report.Report.init(arena);
    defer rep.deinit();

    const root_dir = Io.Dir.openDir(Io.Dir.cwd(), io, opts.root, .{ .iterate = true }) catch |e| {
        try err_out.print("review: cannot open --root={s}: {s}\n", .{ opts.root, @errorName(e) });
        try err_out.flush();
        std.process.exit(2);
    };
    defer Io.Dir.close(root_dir, io);

    var ctx: check.Context = .{
        .alloc = arena,
        .io = io,
        .root_dir = root_dir,
        .report = &rep,
    };

    var ran: usize = 0;
    for (checks.all) |c| {
        if (!opts.wants(c.name)) continue;
        ran += 1;
        c.run(&ctx) catch |e| {
            try err_out.print("review: check '{s}' failed: {s}\n", .{ c.name, @errorName(e) });
            try err_out.flush();
            std.process.exit(2);
        };
    }

    if (ran == 0) {
        try err_out.print("review: no check matched --check={s}\n", .{opts.only});
        try err_out.flush();
        std.process.exit(2);
    }

    if (opts.json) {
        try rep.writeJson(out);
        try out.writeByte('\n');
    } else {
        try rep.writeText(out);
        const errors = rep.countAtLeast(.err);
        const warnings = rep.countAtLeast(.warn) - errors;
        try out.print("\n{d} check(s) ran · {d} error(s) · {d} warning(s)\n", .{ ran, errors, warnings });
    }
    try out.flush();

    if (rep.countAtLeast(.err) > 0) std.process.exit(1);
}

const Options = struct {
    list: bool = false,
    json: bool = false,
    only: []const u8 = "",
    root: []const u8 = ".",

    fn wants(self: Options, name: []const u8) bool {
        if (self.only.len == 0) return true;
        var it = std.mem.splitScalar(u8, self.only, ',');
        while (it.next()) |wanted| {
            if (std.mem.eql(u8, std.mem.trim(u8, wanted, " "), name)) return true;
        }
        return false;
    }
};

test "wants selects every check when --check is absent" {
    const o: Options = .{};
    try std.testing.expect(o.wants("anything"));
}

test "wants matches a comma-separated list and ignores padding" {
    const o: Options = .{ .only = "gate-wiring, ci-coverage" };
    try std.testing.expect(o.wants("gate-wiring"));
    try std.testing.expect(o.wants("ci-coverage"));
    try std.testing.expect(!o.wants("orphan-exports"));
}
