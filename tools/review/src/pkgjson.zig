const std = @import("std");
const Io = std.Io;

const fsutil = @import("fsutil.zig");

/// A parsed `package.json`. The parsed tree borrows from an internal arena, so
/// the value must not outlive this struct.
pub const PackageJson = struct {
    parsed: std.json.Parsed(std.json.Value),

    pub fn deinit(self: *PackageJson) void {
        self.parsed.deinit();
    }

    pub fn root(self: PackageJson) std.json.ObjectMap {
        return switch (self.parsed.value) {
            .object => |o| o,
            else => .empty,
        };
    }

    pub fn stringField(self: PackageJson, name: []const u8) ?[]const u8 {
        const v = self.root().get(name) orelse return null;
        return switch (v) {
            .string => |s| s,
            else => null,
        };
    }

    pub fn script(self: PackageJson, name: []const u8) ?[]const u8 {
        const scripts = self.root().get("scripts") orelse return null;
        const obj = switch (scripts) {
            .object => |o| o,
            else => return null,
        };
        const v = obj.get(name) orelse return null;
        return switch (v) {
            .string => |s| s,
            else => null,
        };
    }

    pub fn hasScript(self: PackageJson, name: []const u8) bool {
        return self.script(name) != null;
    }
};

pub fn load(
    alloc: std.mem.Allocator,
    io: Io,
    dir: Io.Dir,
    path: []const u8,
) !PackageJson {
    const text = try fsutil.readFileAlloc(alloc, io, dir, path);
    defer alloc.free(text);
    return .{ .parsed = try std.json.parseFromSlice(std.json.Value, alloc, text, .{}) };
}

pub fn loadOrNull(
    alloc: std.mem.Allocator,
    io: Io,
    dir: Io.Dir,
    path: []const u8,
) ?PackageJson {
    return load(alloc, io, dir, path) catch null;
}

test "script reads a value and hasScript reports absence" {
    const alloc = std.testing.allocator;
    const parsed = try std.json.parseFromSlice(
        std.json.Value,
        alloc,
        "{\"scripts\":{\"lint\":\"oxlint --type-aware\"}}",
        .{},
    );
    var pkg: PackageJson = .{ .parsed = parsed };
    defer pkg.deinit();

    try std.testing.expectEqualStrings("oxlint --type-aware", pkg.script("lint").?);
    try std.testing.expect(pkg.script("test") == null);
    try std.testing.expect(pkg.hasScript("lint"));
    try std.testing.expect(!pkg.hasScript("test"));
}

test "stringField returns null for non-string and missing fields" {
    const alloc = std.testing.allocator;
    const parsed = try std.json.parseFromSlice(
        std.json.Value,
        alloc,
        "{\"name\":\"x\",\"private\":true}",
        .{},
    );
    var pkg: PackageJson = .{ .parsed = parsed };
    defer pkg.deinit();

    try std.testing.expectEqualStrings("x", pkg.stringField("name").?);
    try std.testing.expect(pkg.stringField("private") == null);
    try std.testing.expect(pkg.stringField("missing") == null);
}
