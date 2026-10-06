const std = @import("std");
const Io = std.Io;

pub const Output = struct {
    stdout: []u8,
    stderr: []u8,
    exit_code: u8,

    pub fn ok(self: Output) bool {
        return self.exit_code == 0;
    }

    pub fn deinit(self: Output, alloc: std.mem.Allocator) void {
        alloc.free(self.stdout);
        alloc.free(self.stderr);
    }
};

/// Run a command to completion and capture its output, with `cwd` as the
/// child's working directory. Caller owns the returned buffers.
///
/// The working directory matters: `--root` points the checks at another
/// checkout, and a generator or `git` that silently ran in the caller's
/// directory instead would report on the wrong tree.
pub fn run(
    alloc: std.mem.Allocator,
    io: Io,
    cwd: Io.Dir,
    argv: []const []const u8,
) !Output {
    const result = try std.process.run(alloc, io, .{ .argv = argv, .cwd = .{ .dir = cwd } });
    return .{
        .stdout = result.stdout,
        .stderr = result.stderr,
        .exit_code = switch (result.term) {
            .exited => |code| code,
            else => 255,
        },
    };
}

test "run captures stdout and the exit code" {
    const alloc = std.testing.allocator;
    const out = try run(alloc, std.testing.io, Io.Dir.cwd(), &.{ "echo", "hello" });
    defer out.deinit(alloc);

    try std.testing.expect(out.ok());
    try std.testing.expectEqualStrings("hello\n", out.stdout);
}

test "run reports a non-zero exit code without failing" {
    const alloc = std.testing.allocator;
    const out = try run(alloc, std.testing.io, Io.Dir.cwd(), &.{ "false" });
    defer out.deinit(alloc);

    try std.testing.expect(!out.ok());
    try std.testing.expectEqual(@as(u8, 1), out.exit_code);
}

test "run honours the working directory it is given" {
    const alloc = std.testing.allocator;
    const dir = try Io.Dir.openDir(Io.Dir.cwd(), std.testing.io, "src", .{});
    defer Io.Dir.close(dir, std.testing.io);

    const out = try run(alloc, std.testing.io, dir, &.{ "pwd" });
    defer out.deinit(alloc);

    try std.testing.expect(out.ok());
    try std.testing.expect(std.mem.endsWith(u8, std.mem.trimEnd(u8, out.stdout, "\n"), "/src"));
}
