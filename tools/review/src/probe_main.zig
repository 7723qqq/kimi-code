const std = @import("std");
const check = @import("check.zig");
const report = @import("report.zig");
const wt = @import("checks/workflow_triggers.zig");
const Io = std.Io;

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const io = init.io;
    var out_buf: [64 * 1024]u8 = undefined;
    var fw: std.Io.File.Writer = .init(.stdout(), init.io, &out_buf);
    const w = &fw.interface;

    const root = try Io.Dir.openDir(Io.Dir.cwd(), io, "../..", .{ .iterate = true });
    defer Io.Dir.close(root, io);
    var rep = report.Report.init(arena);
    var ctx: check.Context = .{ .alloc = arena, .io = io, .root_dir = root, .report = &rep };
    try wt.run(&ctx);
    try rep.writeText(w);
    try w.print("findings={d}\n", .{rep.findings.items.len});
    try w.flush();
}
