const std = @import("std");
const Io = std.Io;

/// Read a whole file into memory, relative to `dir`. Caller owns the slice.
///
/// `Io.Dir.readFile` cannot tell "the file exactly filled the buffer" from
/// "the buffer was too small", so the size is taken from `stat` first and the
/// buffer is one byte larger than the file.
pub fn readFileAlloc(
    alloc: std.mem.Allocator,
    io: Io,
    dir: Io.Dir,
    path: []const u8,
) ![]u8 {
    const st = try Io.Dir.statFile(dir, io, path, .{});
    const size: usize = @intCast(st.size);
    const buf = try alloc.alloc(u8, size + 1);
    errdefer alloc.free(buf);
    const used = try Io.Dir.readFile(dir, io, path, buf);
    // `readFile` hands back a sub-slice of `buf`, and a slice cannot be freed
    // against a larger allocation. Shrink to what was actually read.
    return try alloc.realloc(buf, used.len);
}

/// Read a file, returning null when it does not exist or cannot be read.
/// Used for optional inputs (README, hook files) where absence is normal.
pub fn readFileAllocOrNull(
    alloc: std.mem.Allocator,
    io: Io,
    dir: Io.Dir,
    path: []const u8,
) ?[]u8 {
    return readFileAlloc(alloc, io, dir, path) catch null;
}

test "readFileAlloc reads this source file" {
    const alloc = std.testing.allocator;
    const dir = try Io.Dir.openDir(Io.Dir.cwd(), std.testing.io, "src", .{});
    defer Io.Dir.close(dir, std.testing.io);

    const data = try readFileAlloc(alloc, std.testing.io, dir, "fsutil.zig");
    defer alloc.free(data);
    try std.testing.expect(std.mem.indexOf(u8, data, "readFileAlloc") != null);
}

test "readFileAllocOrNull returns null for a missing file" {
    const alloc = std.testing.allocator;
    const dir = Io.Dir.cwd();
    try std.testing.expect(readFileAllocOrNull(alloc, std.testing.io, dir, "no/such/file.xyz") == null);
}
