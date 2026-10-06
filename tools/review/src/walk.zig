const std = @import("std");
const Io = std.Io;

pub const Options = struct {
    /// Directory names that are never descended into.
    skip_dirs: []const []const u8 = &.{},
    /// File suffixes to keep. Empty means every file is kept.
    suffixes: []const []const u8 = &.{},
};

/// Recursively collect file paths relative to `dir`.
///
/// Directories that cannot be opened are skipped rather than failing the walk:
/// the tool runs over a whole monorepo, and one unreadable directory must not
/// abort the run. Caller owns the returned slice and each path in it.
pub fn collectFiles(
    alloc: std.mem.Allocator,
    io: Io,
    dir: Io.Dir,
    opts: Options,
) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (out.items) |p| alloc.free(p);
        out.deinit(alloc);
    }

    try walkDir(alloc, io, dir, "", opts, &out);
    return out.toOwnedSlice(alloc);
}

pub fn freeFiles(alloc: std.mem.Allocator, files: []const []const u8) void {
    for (files) |p| alloc.free(p);
    alloc.free(files);
}

fn walkDir(
    alloc: std.mem.Allocator,
    io: Io,
    dir: Io.Dir,
    prefix: []const u8,
    opts: Options,
    out: *std.ArrayList([]const u8),
) !void {
    var it = Io.Dir.iterate(dir);
    while (try it.next(io)) |entry| {
        switch (entry.kind) {
            .directory => {
                if (isSkipped(entry.name, opts.skip_dirs)) continue;
                const sub = Io.Dir.openDir(dir, io, entry.name, .{ .iterate = true }) catch continue;
                defer Io.Dir.close(sub, io);
                const child_prefix = try joinPath(alloc, prefix, entry.name);
                defer alloc.free(child_prefix);
                try walkDir(alloc, io, sub, child_prefix, opts, out);
            },
            .file => {
                if (!matchesSuffix(entry.name, opts.suffixes)) continue;
                try out.append(alloc, try joinPath(alloc, prefix, entry.name));
            },
            else => {},
        }
    }
}

fn joinPath(alloc: std.mem.Allocator, prefix: []const u8, name: []const u8) ![]const u8 {
    if (prefix.len == 0) return alloc.dupe(u8, name);
    return std.fs.path.join(alloc, &.{ prefix, name });
}

/// List the immediate sub-directory names of `dir`, sorted. Used to expand
/// workspace globs such as `packages/*`.
pub fn listDirs(
    alloc: std.mem.Allocator,
    io: Io,
    dir: Io.Dir,
) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (out.items) |p| alloc.free(p);
        out.deinit(alloc);
    }

    var it = Io.Dir.iterate(dir);
    while (try it.next(io)) |entry| {
        if (entry.kind != .directory) continue;
        try out.append(alloc, try alloc.dupe(u8, entry.name));
    }
    std.mem.sort([]const u8, out.items, {}, lessThanStr);
    return out.toOwnedSlice(alloc);
}

fn lessThanStr(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.lessThan(u8, a, b);
}

fn isSkipped(name: []const u8, skip_dirs: []const []const u8) bool {
    for (skip_dirs) |s| {
        if (std.mem.eql(u8, name, s)) return true;
    }
    return false;
}

fn matchesSuffix(name: []const u8, suffixes: []const []const u8) bool {
    if (suffixes.len == 0) return true;
    for (suffixes) |s| {
        if (std.mem.endsWith(u8, name, s)) return true;
    }
    return false;
}

test "isSkipped matches exact directory names only" {
    const skip = [_][]const u8{ "node_modules", "dist" };
    try std.testing.expect(isSkipped("node_modules", &skip));
    try std.testing.expect(isSkipped("dist", &skip));
    try std.testing.expect(!isSkipped("dist-web", &skip));
    try std.testing.expect(!isSkipped("src", &skip));
}

test "matchesSuffix keeps everything when no suffix is configured" {
    try std.testing.expect(matchesSuffix("anything.txt", &.{}));
}

test "matchesSuffix filters by suffix" {
    const suffixes = [_][]const u8{ ".ts", ".tsx" };
    try std.testing.expect(matchesSuffix("a.ts", &suffixes));
    try std.testing.expect(matchesSuffix("a.tsx", &suffixes));
    try std.testing.expect(!matchesSuffix("a.js", &suffixes));
    try std.testing.expect(!matchesSuffix("a.ts.bak", &suffixes));
}
