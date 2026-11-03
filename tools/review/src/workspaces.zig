const std = @import("std");
const Io = std.Io;

const check = @import("check.zig");
const pkgjson = @import("pkgjson.zig");
const walk = @import("walk.zig");

pub fn list(ctx: *check.Context, root_pkg: *const pkgjson.PackageJson) ![]const []const u8 {
    const globs = try workspaceGlobs(ctx, root_pkg);
    defer freeStrings(ctx.alloc, globs);
    return expandGlobs(ctx, globs);
}

fn workspaceGlobs(ctx: *check.Context, root_pkg: *const pkgjson.PackageJson) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    errdefer out.deinit(ctx.alloc);

    const ws = root_pkg.root().get("workspaces") orelse return out.toOwnedSlice(ctx.alloc);
    const obj = switch (ws) {
        .object => |o| o,
        else => return out.toOwnedSlice(ctx.alloc),
    };
    const packages = obj.get("packages") orelse return out.toOwnedSlice(ctx.alloc);
    const arr = switch (packages) {
        .array => |a| a,
        else => return out.toOwnedSlice(ctx.alloc),
    };
    for (arr.items) |item| {
        switch (item) {
            .string => |s| try out.append(ctx.alloc, s),
            else => {},
        }
    }
    return out.toOwnedSlice(ctx.alloc);
}

fn expandGlobs(ctx: *check.Context, globs: []const []const u8) ![]const []const u8 {
    var included: std.ArrayList([]const u8) = .empty;
    defer freeStrings(ctx.alloc, included.items);
    var excluded: std.ArrayList([]const u8) = .empty;
    defer excluded.deinit(ctx.alloc);

    for (globs) |g| {
        if (std.mem.startsWith(u8, g, "!")) {
            try excluded.append(ctx.alloc, g[1..]);
            continue;
        }
        if (std.mem.endsWith(u8, g, "/*")) {
            const parent = g[0 .. g.len - 2];
            if (Io.Dir.openDir(ctx.root_dir, ctx.io, parent, .{ .iterate = true })) |dir| {
                defer Io.Dir.close(dir, ctx.io);
                const dirs = walk.listDirs(ctx.alloc, ctx.io, dir) catch continue;
                defer walk.freeFiles(ctx.alloc, dirs);
                for (dirs) |d| {
                    try included.append(ctx.alloc, try std.fmt.allocPrint(
                        ctx.alloc,
                        "{s}/{s}",
                        .{ parent, d },
                    ));
                }
            } else |_| {}
            continue;
        }
        try included.append(ctx.alloc, try ctx.alloc.dupe(u8, g));
    }

    var out: std.ArrayList([]const u8) = .empty;
    errdefer freeStrings(ctx.alloc, out.items);
    for (included.items) |member| {
        var skip = false;
        for (excluded.items) |ex| {
            if (std.mem.eql(u8, member, ex)) skip = true;
        }
        if (!skip) try out.append(ctx.alloc, try ctx.alloc.dupe(u8, member));
    }
    return out.toOwnedSlice(ctx.alloc);
}

pub fn freeStrings(alloc: std.mem.Allocator, items: []const []const u8) void {
    for (items) |s| alloc.free(s);
    alloc.free(items);
}
