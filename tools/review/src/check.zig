const std = @import("std");
const Io = std.Io;
const report = @import("report.zig");
const fsutil = @import("fsutil.zig");

/// Everything a check needs. Checks append findings to `report` and never
/// write to stdout themselves, so the CLI owns all output formatting.
pub const Context = struct {
    alloc: std.mem.Allocator,
    io: Io,
    /// Repository root. Every path a check reads or walks is relative to it.
    root_dir: Io.Dir,
    report: *report.Report,
};

pub const Check = struct {
    /// Stable identifier used by `--check=` and by the baseline file.
    name: []const u8,
    description: []const u8,
    /// The severity a check's findings normally carry, for `--list` and the
    /// help text. It is documentation of intent, not the exit-code driver:
    /// each check sets `.severity` on every finding it adds, and the process
    /// exits 1 on any `.err` finding. Keep the two in step — a check whose
    /// body reports `.err` while this says `.warn` makes `--list` lie.
    severity: report.Severity,
    run: *const fn (ctx: *Context) anyerror!void,
};

/// A ledger of findings a reviewer has already looked at and accepted.
///
/// One entry per line; `#` starts a comment. An entry is a key, optionally
/// followed by whitespace and a value the check interprets. Keys are chosen to
/// survive unrelated edits — a symbol name rather than a line number — so the
/// ledger does not churn every time a file grows, and an entry that stops
/// matching anything is reported so the ledger cannot rot.
pub const Baseline = struct {
    alloc: std.mem.Allocator,
    /// Backing storage for the keys and values below; empty when absent.
    text: []const u8,
    entries: []const Entry,
    used: []bool,

    pub const Entry = struct {
        key: []const u8,
        value: []const u8,
    };

    pub fn load(
        alloc: std.mem.Allocator,
        io: Io,
        dir: Io.Dir,
        path: []const u8,
    ) !Baseline {
        const text = fsutil.readFileAllocOrNull(alloc, io, dir, path) orelse "";
        errdefer if (text.len > 0) alloc.free(text);

        var entries: std.ArrayList(Entry) = .empty;
        errdefer entries.deinit(alloc);

        var lines = std.mem.splitScalar(u8, text, '\n');
        while (lines.next()) |raw| {
            const line = std.mem.trim(u8, raw, " \r\t");
            if (line.len == 0 or line[0] == '#') continue;
            const split = std.mem.indexOfAny(u8, line, " \t") orelse line.len;
            try entries.append(alloc, .{
                .key = line[0..split],
                .value = std.mem.trim(u8, line[split..], " \t"),
            });
        }

        const owned = try entries.toOwnedSlice(alloc);
        errdefer alloc.free(owned);
        const used = try alloc.alloc(bool, owned.len);
        @memset(used, false);

        return .{ .alloc = alloc, .text = text, .entries = owned, .used = used };
    }

    pub fn deinit(self: *Baseline) void {
        self.alloc.free(self.used);
        self.alloc.free(self.entries);
        if (self.text.len > 0) self.alloc.free(self.text);
    }

    /// Look up `key`, marking the entry as used. Returns the entry's value,
    /// which is empty when the entry carries none.
    ///
    /// Path separators compare equal, because the ledger is written with `/`
    /// while a directory walk on Windows hands back `\`. Comparing bytes left
    /// every path-keyed entry unmatched there: the whole ledger read as stale
    /// and every finding read as unlisted, so the accepted debt kept passing
    /// only by accident. Symbol keys carry no separator and are unaffected.
    pub fn get(self: *Baseline, key: []const u8) ?[]const u8 {
        for (self.entries, 0..) |entry, i| {
            if (!eqlIgnoringSeparators(entry.key, key)) continue;
            self.used[i] = true;
            return entry.value;
        }
        return null;
    }

    /// Report every entry no finding matched, so the ledger cannot rot.
    pub fn reportStale(self: *Baseline, ctx: *Context, check_name: []const u8, path: []const u8) !void {
        for (self.entries, 0..) |entry, i| {
            if (self.used[i]) continue;
            try ctx.report.add(.{
                .check = check_name,
                .severity = .info,
                .file = path,
                .message = try std.fmt.allocPrint(
                    ctx.alloc,
                    "baseline entry '{s}' matches nothing; remove it",
                    .{entry.key},
                ),
            });
        }
    }
};

const testing = std.testing;

/// Byte equality with `\` and `/` treated as the same character.
fn eqlIgnoringSeparators(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    for (a, b) |x, y| {
        const left: u8 = if (x == '\\') '/' else x;
        const right: u8 = if (y == '\\') '/' else y;
        if (left != right) return false;
    }
    return true;
}

test "Baseline parses keys, values and comments" {
    const alloc = testing.allocator;
    const text =
        \\# a comment
        \\createThing  packages/x/src/thing.ts
        \\bare
        \\
    ;
    var parsed = try parseForTest(alloc, text);
    defer parsed.deinit();
    try testing.expectEqual(@as(usize, 2), parsed.entries.len);
    try testing.expectEqualStrings("createThing", parsed.entries[0].key);
    try testing.expectEqualStrings("packages/x/src/thing.ts", parsed.entries[0].value);
    try testing.expectEqualStrings("bare", parsed.entries[1].key);
    try testing.expectEqualStrings("", parsed.entries[1].value);
}

test "Baseline.load treats a missing file as an empty ledger" {
    const alloc = testing.allocator;
    const dir = try Io.Dir.openDir(Io.Dir.cwd(), testing.io, "src", .{});
    defer Io.Dir.close(dir, testing.io);

    var baseline = try Baseline.load(alloc, testing.io, dir, "no-such-baseline.txt");
    defer baseline.deinit();
    try testing.expectEqual(@as(usize, 0), baseline.entries.len);
}

test "Baseline.get marks entries used and reportStale names the rest" {
    const alloc = testing.allocator;
    const text =
        \\used
        \\unused
    ;
    var baseline = try parseForTest(alloc, text);
    defer baseline.deinit();

    try testing.expect(baseline.get("used") != null);
    try testing.expect(baseline.get("absent") == null);

    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    var rep = report.Report.init(arena.allocator());
    defer rep.deinit();
    var ctx = Context{ .alloc = arena.allocator(), .io = testing.io, .root_dir = Io.Dir.cwd(), .report = &rep };
    try baseline.reportStale(&ctx, "demo", "baseline.txt");

    try testing.expectEqual(@as(usize, 1), rep.findings.items.len);
    try testing.expect(std.mem.indexOf(u8, rep.findings.items[0].message, "unused") != null);
}

// The ledger is written with `/` while a walk on Windows hands back `\`. A
// byte comparison left every path-keyed entry unmatched there, so the accepted
// debt reported as stale and each finding reported as unlisted.
test "Baseline.get matches a path key across slash styles" {
    const alloc = testing.allocator;
    const text =
        \\packages/agent-core-v2/src/app/git/gitParsers.ts  2
        \\symbolName  1
    ;
    var baseline = try parseForTest(alloc, text);
    defer baseline.deinit();

    try testing.expect(baseline.get("packages/agent-core-v2/src/app/git/gitParsers.ts") != null);
    try testing.expect(baseline.get("packages\\agent-core-v2\\src\\app\\git\\gitParsers.ts") != null);
    try testing.expect(baseline.get("packages\\agent-core-v2\\src\\app\\git\\other.ts") == null);
    try testing.expect(baseline.get("symbolName") != null);
}

/// Build a Baseline from literal text, bypassing the filesystem.
fn parseForTest(alloc: std.mem.Allocator, text: []const u8) !Baseline {
    const owned = try alloc.dupe(u8, text);
    errdefer alloc.free(owned);

    var entries: std.ArrayList(Baseline.Entry) = .empty;
    errdefer entries.deinit(alloc);
    var lines = std.mem.splitScalar(u8, owned, '\n');
    while (lines.next()) |raw| {
        const line = std.mem.trim(u8, raw, " \r\t");
        if (line.len == 0 or line[0] == '#') continue;
        const split = std.mem.indexOfAny(u8, line, " \t") orelse line.len;
        try entries.append(alloc, .{
            .key = line[0..split],
            .value = std.mem.trim(u8, line[split..], " \t"),
        });
    }
    const slice = try entries.toOwnedSlice(alloc);
    errdefer alloc.free(slice);
    const used = try alloc.alloc(bool, slice.len);
    @memset(used, false);
    return .{ .alloc = alloc, .text = owned, .entries = slice, .used = used };
}
