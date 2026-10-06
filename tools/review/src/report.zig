const std = @import("std");
const Io = std.Io;

pub const Severity = enum {
    err,
    warn,
    info,

    pub fn label(self: Severity) []const u8 {
        return switch (self) {
            .err => "error",
            .warn => "warn",
            .info => "info",
        };
    }

    /// Ordering used to decide whether a finding should fail the run.
    pub fn rank(self: Severity) u8 {
        return switch (self) {
            .err => 2,
            .warn => 1,
            .info => 0,
        };
    }
};

pub const Finding = struct {
    check: []const u8,
    severity: Severity,
    file: []const u8,
    line: u32 = 0,
    message: []const u8,
    evidence: []const u8 = "",
};

pub const Report = struct {
    alloc: std.mem.Allocator,
    findings: std.ArrayList(Finding) = .empty,

    pub fn init(alloc: std.mem.Allocator) Report {
        return .{ .alloc = alloc };
    }

    pub fn deinit(self: *Report) void {
        self.findings.deinit(self.alloc);
    }

    pub fn add(self: *Report, finding: Finding) !void {
        try self.findings.append(self.alloc, finding);
    }

    pub fn countAtLeast(self: *const Report, threshold: Severity) usize {
        var n: usize = 0;
        for (self.findings.items) |f| {
            if (f.severity.rank() >= threshold.rank()) n += 1;
        }
        return n;
    }

    pub fn writeText(self: *const Report, writer: *Io.Writer) !void {
        for (self.findings.items) |f| {
            if (f.line > 0) {
                try writer.print("{s}  {s}  {s}:{d}  {s}\n", .{
                    f.severity.label(), f.check, f.file, f.line, f.message,
                });
            } else {
                try writer.print("{s}  {s}  {s}  {s}\n", .{
                    f.severity.label(), f.check, f.file, f.message,
                });
            }
            if (f.evidence.len > 0) {
                try writer.print("       evidence: {s}\n", .{f.evidence});
            }
        }
    }

    pub fn writeJson(self: *const Report, writer: *Io.Writer) !void {
        try writer.writeAll("{\"findings\":[");
        for (self.findings.items, 0..) |f, i| {
            if (i > 0) try writer.writeAll(",");
            try writer.writeAll("{\"check\":");
            try writeJsonString(writer, f.check);
            try writer.writeAll(",\"severity\":");
            try writeJsonString(writer, f.severity.label());
            try writer.writeAll(",\"file\":");
            try writeJsonString(writer, f.file);
            try writer.print(",\"line\":{d},\"message\":", .{f.line});
            try writeJsonString(writer, f.message);
            try writer.writeAll(",\"evidence\":");
            try writeJsonString(writer, f.evidence);
            try writer.writeAll("}");
        }
        try writer.writeAll("]}");
    }
};

/// Minimal JSON string encoder: escapes the characters JSON requires and
/// passes everything else through as UTF-8.
pub fn writeJsonString(writer: *Io.Writer, s: []const u8) !void {
    try writer.writeByte('"');
    for (s) |c| {
        switch (c) {
            '"' => try writer.writeAll("\\\""),
            '\\' => try writer.writeAll("\\\\"),
            '\n' => try writer.writeAll("\\n"),
            '\r' => try writer.writeAll("\\r"),
            '\t' => try writer.writeAll("\\t"),
            0x08 => try writer.writeAll("\\b"),
            0x0c => try writer.writeAll("\\f"),
            else => {
                if (c < 0x20) {
                    try writer.print("\\u{x:0>4}", .{c});
                } else {
                    try writer.writeByte(c);
                }
            },
        }
    }
    try writer.writeByte('"');
}

test "countAtLeast respects severity ordering" {
    var report = Report.init(std.testing.allocator);
    defer report.deinit();

    try report.add(.{ .check = "a", .severity = .info, .file = "f", .message = "m" });
    try report.add(.{ .check = "b", .severity = .warn, .file = "f", .message = "m" });
    try report.add(.{ .check = "c", .severity = .err, .file = "f", .message = "m" });

    try std.testing.expectEqual(@as(usize, 3), report.countAtLeast(.info));
    try std.testing.expectEqual(@as(usize, 2), report.countAtLeast(.warn));
    try std.testing.expectEqual(@as(usize, 1), report.countAtLeast(.err));
}

test "writeJsonString escapes quotes, backslashes and control characters" {
    var buf: [256]u8 = undefined;
    var writer: Io.Writer = .fixed(&buf);
    try writeJsonString(&writer, "a\"b\\c\nd\x01");
    try std.testing.expectEqualStrings("\"a\\\"b\\\\c\\nd\\u0001\"", writer.buffered());
}
