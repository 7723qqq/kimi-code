const std = @import("std");

/// A deliberately small YAML reader for the shapes GitHub Actions files use:
/// mappings, sequences, block scalars (`|` and `>`), flow sequences, and quoted
/// or plain scalars. Anchors, aliases, tags, multi-document streams and
/// explicit `?` keys are not handled; a file that uses one of them comes back
/// with `unsupported` set rather than parsed on a guess, and callers skip it.
///
/// YAML has no way to tell a two-space indent step from a four-space one, so
/// the reader takes the step as a parameter and measures it from the file's
/// first indented line. Indentation that is not a multiple of that step means
/// the file uses two widths at once, which this reader cannot follow; such a
/// file is reported unsupported rather than read differently than intended.
pub const Node = union(enum) {
    scalar: []const u8,
    map: Map,
    seq: Seq,

    pub const Entry = struct {
        key: []const u8,
        value: Node,
    };

    pub const Map = struct {
        entries: []const Entry,

        pub fn get(self: Map, key: []const u8) ?Node {
            for (self.entries) |e| {
                if (std.mem.eql(u8, e.key, key)) return e.value;
            }
            return null;
        }

        pub fn getScalar(self: Map, key: []const u8) ?[]const u8 {
            return switch (self.get(key) orelse return null) {
                .scalar => |s| s,
                else => null,
            };
        }

        pub fn getMap(self: Map, key: []const u8) ?Map {
            return switch (self.get(key) orelse return null) {
                .map => |m| m,
                else => null,
            };
        }

        pub fn getSeq(self: Map, key: []const u8) ?Seq {
            return switch (self.get(key) orelse return null) {
                .seq => |s| s,
                else => null,
            };
        }
    };

    pub const Seq = struct {
        items: []const Node,
    };
};

pub const Root = struct {
    alloc: std.mem.Allocator,
    doc: ?Node = null,
    /// Set when the file used a construct this reader does not understand.
    unsupported: bool = false,

    pub fn deinit(self: *Root) void {
        if (self.doc) |d| freeNode(self.alloc, d);
        self.doc = null;
    }

    pub fn map(self: Root) ?Node.Map {
        return switch (self.doc orelse return null) {
            .map => |m| m,
            else => null,
        };
    }
};

/// Everything the parser can fail with. Declared explicitly because
/// `parseBlock`, `parseSeq` and `parseMap` are mutually recursive, and Zig
/// cannot infer an error set through a cycle.
pub const ParseError = std.mem.Allocator.Error;

pub fn parse(alloc: std.mem.Allocator, text: []const u8) ParseError!Root {
    var cur = Cursor{ .text = text };
    var root: Root = .{ .alloc = alloc };
    errdefer root.deinit();

    root.doc = try parseBlock(alloc, &cur, 0, 1, 2, &root.unsupported);
    return root;
}

// --- parsing ---------------------------------------------------------------

const Cursor = struct {
    text: []const u8,
    pos: usize = 0,
    /// A line already read past the current block, handed back to the caller.
    pending: ?[]const u8 = null,

    fn next(self: *Cursor) ?[]const u8 {
        if (self.pending) |p| {
            self.pending = null;
            return p;
        }
        if (self.pos >= self.text.len) return null;
        const nl = std.mem.indexOfScalarPos(u8, self.text, self.pos, '\n') orelse self.text.len;
        const line = self.text[self.pos..nl];
        self.pos = if (nl < self.text.len) nl + 1 else nl;
        return line;
    }

    fn putBack(self: *Cursor, line: []const u8) void {
        self.pending = line;
    }
};

const Line = struct {
    /// The line with its trailing comment removed and whitespace trimmed away.
    content: []const u8,
    indent: usize,
};

fn readLine(cur: *Cursor) ?Line {
    while (cur.next()) |raw| {
        const content = stripComment(raw);
        if (content.len == 0) continue;
        return .{ .content = content, .indent = indentOf(content) };
    }
    return null;
}

/// Parse the block that starts at `cur`, whose own indentation is `indent`.
/// `stack` is the chain of block indents currently open, outermost first; it
/// exists to reject indentation this reader cannot represent (see the note on
/// the indent step in the file comment).
fn parseBlock(
    alloc: std.mem.Allocator,
    cur: *Cursor,
    indent: usize,
    depth: usize,
    width: usize,
    unsupported: *bool,
) ParseError!?Node {
    if (depth > 40) {
        unsupported.* = true;
        return null;
    }
    const first = readLine(cur) orelse return null;
    if (first.indent < indent) {
        cur.putBack(first.content);
        return null;
    }
    if (first.indent != indent) {
        unsupported.* = true;
        return null;
    }

    if (atSequenceEntry(first.content)) {
        return try parseSeq(alloc, cur, indent, depth, width, unsupported, first);
    }
    return try parseMap(alloc, cur, indent, depth, width, unsupported, first);
}

/// `content` with its indentation removed. `atSequenceEntry` and the rest of
/// the sequence handling all work on the trimmed form, so that a `- ` nested
/// under a key is recognised as a sequence entry rather than read as a key.
fn body(content: []const u8) []const u8 {
    const at = indentOf(content);
    return content[at..];
}

fn atSequenceEntry(content: []const u8) bool {
    const line = body(content);
    return line.len > 0 and line[0] == '-';
}

fn parseSeq(
    alloc: std.mem.Allocator,
    cur: *Cursor,
    indent: usize,
    depth: usize,
    width: usize,
    unsupported: *bool,
    first: Line,
) ParseError!?Node {
    var items: std.ArrayList(Node) = .empty;
    errdefer freeItems(alloc, items.items);

    var current: Line = first;
    while (true) {
        const rest = std.mem.trim(u8, skipDash(body(current.content)), " \t");
        if (rest.len == 0) {
            // `-` alone: the item is the indented block beneath it.
            const child = try parseBlock(alloc, cur, indent + width, depth + 1, width, unsupported);
            if (unsupported.*) return null;
            try items.append(alloc, child orelse .{ .scalar = "" });
        } else if (splitKey(rest) != null) {
            // A `- key: value` entry starts an inline mapping. The keys that
            // follow the first one sit at the dash's own column, one step below
            // it; `parseMapFrom` tells the two apart from the indent each line
            // actually carries, so it is entered with the dash's indent and
            // `first` describing a line that starts at `indent + width`.
            const child = try parseMapFrom(alloc, cur, indent, depth + 1, width, unsupported, .{
                .content = rest,
                .indent = indent + width,
            });
            if (unsupported.*) return null;
            try items.append(alloc, child orelse .{ .scalar = "" });
        } else {
            try items.append(alloc, .{ .scalar = try alloc.dupe(u8, rest) });
        }

        const next = readLine(cur) orelse break;
        if (next.indent < indent) {
            cur.putBack(next.content);
            break;
        }
        if (next.indent > indent) {
            unsupported.* = true;
            return null;
        }
        if (!atSequenceEntry(next.content)) {
            cur.putBack(next.content);
            break;
        }
        current = next;
    }

    return .{ .seq = .{ .items = try items.toOwnedSlice(alloc) } };
}

fn skipDash(content: []const u8) []const u8 {
    if (content.len == 0 or content[0] != '-') return content;
    if (content.len >= 2 and content[1] != ' ' and content[1] != '\t') return content;
    return content[1..];
}

fn parseMap(
    alloc: std.mem.Allocator,
    cur: *Cursor,
    indent: usize,
    depth: usize,
    width: usize,
    unsupported: *bool,
    first: Line,
) ParseError!?Node {
    return parseMapFrom(alloc, cur, indent, depth, width, unsupported, .{
        .content = first.content,
        .indent = indent,
    });
}

fn parseMapFrom(
    alloc: std.mem.Allocator,
    cur: *Cursor,
    indent: usize,
    depth: usize,
    width: usize,
    unsupported: *bool,
    first: Line,
) ParseError!?Node {
    var entries: std.ArrayList(Node.Entry) = .empty;
    // Entries are handed to the caller as a slice, so a failure part-way
    // through gives them to `freeNode` — which frees nested values too, and
    // that is the only way to reach the ones already appended.
    const Ctx = struct {
        entries: *std.ArrayList(Node.Entry),
        alloc: std.mem.Allocator,

        fn giveUp(self: @This()) void {
            const slice = self.entries.toOwnedSlice(self.alloc) catch {
                self.entries.deinit(self.alloc);
                return;
            };
            freeEntries(self.alloc, slice);
        }
    };
    const ctx: Ctx = .{ .entries = &entries, .alloc = alloc };
    errdefer freeEntries(alloc, entries.items);

    // A `- key:` entry is handed in with the dash line's indent and a `first`
    // whose own indent sits one step deeper. Every other entry of that mapping
    // is indented to the first entry's column, and a nested block starts one
    // step past it. The two are the same number whenever the caller passed a
    // `first` line at its real indentation, which is the common case.
    const entry_indent = if (first.indent > indent) first.indent else indent;

    var current: Line = first;
    while (true) {
        const colon = splitKey(current.content) orelse {
            unsupported.* = true;
            ctx.giveUp();
            return null;
        };
        const key = try alloc.dupe(u8, unquote(std.mem.trim(u8, current.content[0..colon], " \t")));
        const value_text = std.mem.trim(u8, current.content[colon + 1 ..], " \t");

        const value: Node = if (value_text.len == 0)
            (try parseBlock(alloc, cur, entry_indent + width, depth + 1, width, unsupported)) orelse .{ .scalar = "" }
        else if (value_text[0] == '|' or value_text[0] == '>')
            .{ .scalar = try parseBlockScalar(alloc, cur, entry_indent, width) }
        else
            .{ .scalar = try alloc.dupe(u8, unquote(value_text)) };

        if (unsupported.*) {
            // Neither the key nor the value is in `entries` yet; both belong to
            // this frame, and `freeNode` reaches whatever nested under a value.
            alloc.free(key);
            freeNode(alloc, value);
            ctx.giveUp();
            return null;
        }
        try entries.append(alloc, .{ .key = key, .value = value });

        const next = readLine(cur) orelse break;
        if (next.indent < entry_indent) {
            cur.putBack(next.content);
            break;
        }
        if (next.indent > entry_indent) {
            unsupported.* = true;
            ctx.giveUp();
            return null;
        }
        // Another `- ` at this sequence's own column ends the entry's mapping;
        // a `- ` one step in is a sequence nested under a key already consumed.
        if (next.indent <= entry_indent and atSequenceEntry(next.content)) {
            cur.putBack(next.content);
            break;
        }
        current = next;
    }

    return .{ .map = .{ .entries = try entries.toOwnedSlice(alloc) } };
}

/// Replace a block scalar with its content, newlines kept. Callers only ask
/// whether a value is empty, and the reader keeps the folded and literal forms
/// alike as text.
fn parseBlockScalar(alloc: std.mem.Allocator, cur: *Cursor, indent: usize, width: usize) ParseError![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(alloc);
    while (cur.next()) |raw| {
        if (std.mem.trim(u8, raw, " \t\r").len == 0) {
            // A blank line inside the block carries no content but would still
            // be part of it; the content only feeds an emptiness test, so it is
            // skipped and the newline is not counted.
            continue;
        }
        if (indentOf(raw) % width != 0) {
            // A tab, or a width this file does not use. The line belongs to the
            // block either way, so it is kept; only the indentation check above
            // is skipped for it.
            try out.appendSlice(alloc, std.mem.trim(u8, raw, " \t\r"));
            try out.append(alloc, '\n');
            continue;
        }
        // The block ends at the first non-blank line indented no further than
        // the key that introduced it.
        if (indentOf(raw) <= indent) {
            cur.putBack(raw);
            break;
        }
        // A `- ` continuation of the sequence this key sits in is not content.
        if (indentOf(raw) % width == 0 and atSequenceEntry(raw) and indentOf(raw) <= indent + width)
        {
            cur.putBack(raw);
            break;
        }
        try out.appendSlice(alloc, std.mem.trim(u8, raw, " \t\r"));
        try out.append(alloc, '\n');
    }
    return try out.toOwnedSlice(alloc);
}

fn splitKey(content: []const u8) ?usize {
    var quote: u8 = 0;
    for (content, 0..) |c, i| {
        if (quote != 0) {
            if (c == quote) quote = 0;
            continue;
        }
        if (c == '\'' or c == '"') {
            quote = c;
            continue;
        }
        if (c != ':') continue;
        if (i + 1 == content.len or content[i + 1] == ' ' or content[i + 1] == '\t') return i;
    }
    return null;
}

fn unquote(s: []const u8) []const u8 {
    if (s.len >= 2 and ((s[0] == '\'' and s[s.len - 1] == '\'') or (s[0] == '"' and s[s.len - 1] == '"'))) {
        return s[1 .. s.len - 1];
    }
    return s;
}

fn stripComment(raw: []const u8) []const u8 {
    // Only the right edge is trimmed: leading spaces are the indentation, and
    // measuring them after a full trim is what made every line look like it
    // started at column zero. A `#` at the start of the trimmed line is a
    // comment, not content — a `#` inside a line is left alone, since it can
    // also start a colour code or sit inside a quoted string, and no key of
    // interest to this tool carries one.
    var end = raw.len;
    while (end > 0 and (raw[end - 1] == ' ' or raw[end - 1] == '\t' or raw[end - 1] == '\r')) end -= 1;
    const line = raw[0..end];
    const at = indentOf(line);
    if (at < line.len and line[at] == '#') return line[0..0];
    return line;
}

fn indentOf(line: []const u8) usize {
    var n: usize = 0;
    while (n < line.len and line[n] == ' ') n += 1;
    return n;
}

fn freeNode(alloc: std.mem.Allocator, node: Node) void {
    switch (node) {
        .scalar => |s| if (s.len > 0) alloc.free(s),
        .map => |m| freeEntries(alloc, m.entries),
        .seq => |s| freeItems(alloc, s.items),
    }
}

fn freeEntries(alloc: std.mem.Allocator, entries: []const Node.Entry) void {
    for (entries) |e| {
        alloc.free(e.key);
        freeNode(alloc, e.value);
    }
    alloc.free(entries);
}

fn freeItems(alloc: std.mem.Allocator, items: []const Node) void {
    for (items) |item| freeNode(alloc, item);
    alloc.free(items);
}

// --- run: extraction -------------------------------------------------------

/// True when a `run:` step's shell would expand an expression inside a command
/// substitution. Outside `run:` the expression is evaluated by Actions itself,
/// so a `$( ... )` there is literal text, not something to skip over.
pub const ExpandsInsideCommandSubstitution = enum { yes, no };

/// Append every shell command a workflow would execute to `out`, each entry
/// prefixed with `rel_path:line`. A step's `run:` is written as one entry, with
/// `${{ ... }}` spans removed; every other line of the document is ignored.
///
/// The commands come from the parsed document, so a `run:` inside a comment or
/// inside another step's block scalar is not mistaken for a step. The line each
/// one is reported at comes from the raw file, because the parser folds a block
/// scalar's lines into its value and cannot recover where the keys that follow
/// it were written.
pub fn collectRunCommands(
    alloc: std.mem.Allocator,
    out: *std.ArrayList(u8),
    text: []const u8,
    rel_path: []const u8,
    expansion: ExpandsInsideCommandSubstitution,
) ParseError!void {
    var docs: std.ArrayList(Doc) = .empty;
    defer docs.deinit(alloc);
    try splitDocuments(alloc, &docs, text);

    for (docs.items) |doc| {
        var root = try parse(alloc, doc.text);
        defer root.deinit();
        // A file this reader cannot follow is left alone entirely: reporting
        // commands read from half a document would be worse than silence.
        if (root.unsupported) continue;

        const values = try runValues(alloc, root.doc orelse continue);
        defer alloc.free(values);

        var cursor_line = doc.start_line;
        for (values) |value| {
            // The first line of `value` that the file itself carries is where
            // the `run:` key sits; a block scalar's first content line is the
            // command, which is the line worth pointing at. Values are in
            // document order, so the search resumes below the previous hit
            // rather than matching the same line repeatedly.
            const line = lineOfFirstCommand(doc, value, cursor_line);
            cursor_line = line;
            try out.appendSlice(alloc, rel_path);
            try out.print(alloc, ":{d} ", .{line});
            try appendWithoutExpressions(alloc, out, value, expansion);
            try out.append(alloc, '\n');
        }
    }
}

/// Every `run:` scalar in the document, in the order they are written.
fn runValues(alloc: std.mem.Allocator, node: Node) ParseError![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    errdefer out.deinit(alloc);
    try collectRunValues(&out, alloc, node);
    return out.toOwnedSlice(alloc);
}

fn collectRunValues(out: *std.ArrayList([]const u8), alloc: std.mem.Allocator, node: Node) ParseError!void {
    switch (node) {
        .scalar => {},
        .seq => |s| for (s.items) |item| try collectRunValues(out, alloc, item),
        .map => |m| for (m.entries) |e| {
            if (std.mem.eql(u8, e.key, "run")) {
                switch (e.value) {
                    .scalar => |v| try out.append(alloc, v),
                    else => {},
                }
                continue;
            }
            try collectRunValues(out, alloc, e.value);
        },
    }
}

/// Where `value` starts in the file, looking no higher than `from_line`. A
/// scalar that appears as its own line is found by that line; a block scalar's
/// text starts on the command below the key, so its first line is what gets
/// matched and the key's line is one above.
fn lineOfFirstCommand(doc: Doc, value: []const u8, from_line: u32) u32 {
    const is_block = std.mem.indexOf(u8, value, "\n") != null;
    const first_line = value[0 .. std.mem.indexOfScalar(u8, value, '\n') orelse value.len];
    // A block scalar's text starts on the command below its `run: |`, so the
    // key line is what gets matched and the result is the line after it. An
    // inline value sits on the key's own line, dash and all, so the match is
    // on the `run:` that introduces it followed by the value.
    const needle = if (is_block) "run:" else "run: ";

    var line_no = doc.start_line;
    var lines = std.mem.splitScalar(u8, doc.text, '\n');
    while (lines.next()) |raw| : (line_no += 1) {
        if (line_no < from_line) continue;
        const trimmed = std.mem.trim(u8, raw, " \t");
        if (is_block) {
            if (!std.mem.startsWith(u8, trimmed, needle)) continue;
            return line_no + 1;
        }
        const key = std.mem.indexOf(u8, trimmed, needle) orelse continue;
        const rest = std.mem.trim(u8, trimmed[key + needle.len ..], " \t");
        if (!std.mem.startsWith(u8, rest, first_line)) continue;
        return line_no;
    }
    return doc.start_line;
}

/// One YAML document of a stream: its text and the line number its first line
/// has in the file.
const Doc = struct {
    text: []const u8,
    start_line: u32,
};

/// Split `text` on `---` document-start markers, honouring the marker only at
/// column zero (where YAML allows it).
fn splitDocuments(alloc: std.mem.Allocator, out: *std.ArrayList(Doc), text: []const u8) !void {
    var start: usize = 0;
    var line_no: u32 = 1;
    var doc_start_line: u32 = 1;
    var pos: usize = 0;
    while (pos <= text.len) {
        const nl = std.mem.indexOfScalarPos(u8, text, pos, '\n') orelse text.len;
        const line = text[pos..nl];
        if (std.mem.startsWith(u8, line, "---") and isDocumentMarker(line)) {
            try out.append(alloc, .{ .text = text[start..pos], .start_line = doc_start_line });
            start = nl + 1;
            doc_start_line = line_no + 1;
        }
        line_no += 1;
        if (nl >= text.len) break;
        pos = nl + 1;
    }
    try out.append(alloc, .{ .text = text[start..], .start_line = doc_start_line });
}

fn isDocumentMarker(line: []const u8) bool {
    const rest = std.mem.trim(u8, line["---".len..], " \t\r");
    return rest.len == 0 or rest[0] == '#';
}


/// Walk the parsed document and report each `run:` scalar at the line it came
/// from. Going through the parse tree rather than the raw lines is what keeps a
/// `run:` written inside a block scalar or a comment from being mistaken for a
/// step of its own.
///
/// Every node carries the file line it was written on, so a finding points at
/// the command rather than at the key that introduced it — which is what makes
/// the line usable in an editor.
const Walk = struct {
    alloc: std.mem.Allocator,
    out: *std.ArrayList(u8),
    rel_path: []const u8,
    expansion: ExpandsInsideCommandSubstitution,
    /// The file line the node being visited starts on.
    line: u32,

    fn node(self: *Walk, n: Node) ParseError!void {
        switch (n) {
            .scalar => {},
            .seq => |s| for (s.items) |item| try self.node(item),
            .map => |m| for (m.entries) |e| {
                if (std.mem.eql(u8, e.key, "run")) {
                    const value = switch (e.value) {
                        .scalar => |v| v,
                        else => continue,
                    };
                    try self.out.appendSlice(self.alloc, self.rel_path);
                    try self.out.print(self.alloc, ":{d} ", .{self.line});
                    try appendWithoutExpressions(self.alloc, self.out, value, self.expansion);
                    try self.out.append(self.alloc, '\n');
                    self.line += 1 + newlinesIn(e.value);
                    continue;
                }
                // The value of a key begins on the key's own line, so the
                // running count only advances once that entry is done.
                const start = self.line;
                try self.node(e.value);
                self.line = start + 1 + newlinesIn(e.value);
            },
        }
    }
};

fn newlinesIn(node: Node) u32 {
    // Only a block scalar carries newlines; a mapping or sequence value folds
    // the newlines into the entries that follow, each of which counts its own.
    const text = switch (node) {
        .scalar => |s| s,
        else => return 0,
    };
    var n: u32 = 0;
    for (text) |c| {
        if (c == '\n') n += 1;
    }
    return n;
}

/// Append `line` with every `${{ ... }}` span dropped.
///
/// GitHub expands `${{ ... }}` before the shell ever sees the command, but what
/// it expands to is a runtime value — a matrix target, an event name — that
/// this tool cannot know. Dropping the span keeps the surrounding literal text,
/// which is the part that is actually checkable, rather than inventing a value.
fn appendWithoutExpressions(
    alloc: std.mem.Allocator,
    out: *std.ArrayList(u8),
    line: []const u8,
    expansion: ExpandsInsideCommandSubstitution,
) ParseError!void {
    var i: usize = 0;
    var in_subshell = false;
    while (i < line.len) {
        if (line[i] == '\\') {
            try out.append(alloc, line[i]);
            i += 1;
            if (i < line.len) {
                try out.append(alloc, line[i]);
                i += 1;
            }
            continue;
        }
        if (expansion == .yes and line[i] == '$' and i + 1 < line.len and line[i + 1] == '(') {
            in_subshell = true;
        } else if (in_subshell and line[i] == ')') {
            in_subshell = false;
        }
        if (!in_subshell and line[i] == '$' and i + 2 < line.len and line[i + 1] == '{' and line[i + 2] == '{') {
            var depth: usize = 0;
            i += 3;
            while (i < line.len) : (i += 1) {
                if (line[i] == '{') depth += 1;
                if (line[i] == '}') {
                    if (depth == 0) {
                        i += 1;
                        if (i < line.len and line[i] == '}') i += 1;
                        break;
                    }
                    depth -= 1;
                }
            }
            continue;
        }
        try out.append(alloc, line[i]);
        i += 1;
    }
}

const testing = std.testing;

fn parseForTest(alloc: std.mem.Allocator, text: []const u8) ParseError!Root {
    return parse(alloc, text);
}

test "parse reads the nested mapping a workflow is written in" {
    const alloc = testing.allocator;
    var root = try parseForTest(
        alloc,
        \\name: CI
        \\on:
        \\  pull_request:
        \\  push:
        \\    branches:
        \\      - main
        \\permissions:
        \\  contents: read
        \\jobs:
        \\  build:
        \\    runs-on: ubuntu-latest
        \\    steps:
        \\      - uses: actions/checkout@v4
        \\      - name: Typecheck
        \\        run: bun run typecheck
    );
    defer root.deinit();

    try testing.expect(!root.unsupported);
    var doc = root.map().?;
    try testing.expectEqualStrings("CI", doc.getScalar("name").?);

    const on = doc.getMap("on").?;
    try testing.expect(on.get("pull_request") != null);
    try testing.expect(on.get("push") != null);

    var jobs = doc.getMap("jobs").?;
    const build = jobs.getMap("build").?;
    try testing.expectEqualStrings("ubuntu-latest", build.getScalar("runs-on").?);

    const steps = build.getSeq("steps").?;
    try testing.expectEqual(@as(usize, 2), steps.items.len);
    const first = switch (steps.items[0]) {
        .map => |m| m,
        else => return error.Unexpected,
    };
    try testing.expectEqualStrings("actions/checkout@v4", first.getScalar("uses").?);
    const second = switch (steps.items[1]) {
        .map => |m| m,
        else => return error.Unexpected,
    };
    try testing.expectEqualStrings("Typecheck", second.getScalar("name").?);
    try testing.expectEqualStrings("bun run typecheck", second.getScalar("run").?);
}

test "parse reads the top-level sequence a workflow trigger is written as" {
    const alloc = testing.allocator;
    var root = try parseForTest(
        alloc,
        \\on:
        \\  push:
        \\    branches:
        \\      - main
    );
    defer root.deinit();

    const branches = root.map().?.getMap("on").?.getMap("push").?.getSeq("branches").?;
    try testing.expectEqual(@as(usize, 1), branches.items.len);
    try testing.expectEqualStrings("main", switch (branches.items[0]) {
        .scalar => |s| s,
        else => return error.Unexpected,
    });
}

test "a block scalar keeps its lines and a later key still parses" {
    const alloc = testing.allocator;
    var root = try parseForTest(
        alloc,
        \\steps:
        \\  - run: |
        \\      set -euo pipefail
        \\      bun run lint
        \\    name: Lint
    );
    defer root.deinit();

    try testing.expect(!root.unsupported);
    const step = switch (root.map().?.getSeq("steps").?.items[0]) {
        .map => |m| m,
        else => return error.Unexpected,
    };
    try testing.expectEqualStrings("Lint", step.getScalar("name").?);
    try testing.expect(std.mem.indexOf(u8, step.getScalar("run").?, "bun run lint") != null);
}

test "mixed indent widths are reported unsupported, not guessed at" {
    const alloc = testing.allocator;
    var root = try parseForTest(
        alloc,
        \\jobs:
        \\    build:
        \\      runs-on: ubuntu-latest
    );
    defer root.deinit();
    try testing.expect(root.unsupported);
}

test "collectRunCommands emits block and inline commands with their lines" {
    const alloc = testing.allocator;
    const text =
        \\jobs:
        \\  lint:
        \\    steps:
        \\      - run: bun run lint
        \\      - name: Locale
        \\        run: |
        \\          bun scripts/check-locale-keys.mjs
        \\          bun scripts/check-locale-placeholders.cjs
        \\  review:
        \\    steps:
        \\      - run: cd tools/review && zig build
    ;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(alloc);
    try collectRunCommands(alloc, &out, text, "ci.yml", .yes);

    try testing.expect(std.mem.indexOf(u8, out.items, "ci.yml:4 bun run lint") != null);
    // A block scalar reports the line of the first command it holds, so a
    // finding points at the command rather than at the introducing `run:`.
    try testing.expect(std.mem.indexOf(u8, out.items, "ci.yml:7 bun scripts/check-locale-keys.mjs\nbun scripts/check-locale-placeholders.cjs") != null);
    try testing.expect(std.mem.indexOf(u8, out.items, "ci.yml:11 cd tools/review && zig build") != null);
}

test "collectRunCommands drops what an expression expands to" {
    const alloc = testing.allocator;
    const text =
        \\jobs:
        \\  test:
        \\    steps:
        \\      - run: bun --bun run test --shard=${{ matrix.shard }}/5
        \\      - run: echo "$(git rev-parse ${{ env.REF }})"
    ;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(alloc);
    try collectRunCommands(alloc, &out, text, "ci.yml", .yes);

    // An expression the workflow substitutes is dropped: what it expands to is
    // a runtime value this tool cannot know, and a finding phrased around a
    // guessed value would be worse than one that omits it.
    try testing.expect(std.mem.indexOf(u8, out.items, "bun --bun run test --shard=/5") != null);
    // Inside a `$( ... )` the same text is expanded by the shell instead, so
    // the literal source survives and the command stays readable.
    try testing.expect(std.mem.indexOf(u8, out.items, "echo \"$(git rev-parse ${{ env.REF }})\"") != null);
}

test "collectRunCommands keeps expressions when the shell cannot expand them" {
    const alloc = testing.allocator;
    const text = "jobs:\n  x:\n    steps:\n      - run: bun scripts/gen.mjs --out=${{ github.workspace }}/x\n";
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(alloc);
    try collectRunCommands(alloc, &out, text, "x.yml", .no);
    try testing.expect(std.mem.indexOf(u8, out.items, "--out=/x") != null);
}
