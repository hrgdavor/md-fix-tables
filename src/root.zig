//! `md-fix-tables` — re-align every pipe table in a Markdown document.
//!
//! This is a byte-for-byte Zig port of `md-fix-tables.js`: given the same input
//! bytes (decoded as WHATWG UTF-8, exactly like Node's `readFileSync(path,
//! 'utf-8')`) and the same `--max-col`, it emits exactly the same output bytes.
//!
//! Every length the algorithm uses is a count of *UTF-16 code units* — the unit
//! of `String.prototype.length` in JavaScript — so column widths and padding
//! agree with the JS implementation character for character, not just byte for
//! byte. Where a JS detail is being mirrored the comments say so.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;

/// A cell at/over this width never sets a column width and is never padded.
pub const MAX_COL: usize = 100;

/// The smallest legal markdown separator (`---`).
pub const MIN_COL: usize = 3;

/// The published version, printed by `-V` / `--version`. The JS tool reads it
/// from `package.json`, so this literal and `build.zig.zon` must be bumped
/// together with it; `test-fix-tables.test.js` asserts the three agree.
pub const VERSION = "1.2.0";

/// `md-fix-tables --help`, byte for byte the `HELP` string in
/// `md-fix-tables.js`. The two have to be edited together.
pub const HELP =
    \\md-fix-tables — re-align every pipe table in a Markdown document
    \\
    \\Usage:
    \\  md-fix-tables [options] [file]
    \\
    \\  With a file, its tables are rewritten in place and nothing is printed.
    \\  Without one, stdin is read and the aligned document goes to stdout.
    \\
    \\Options:
    \\  -m, --max-col <n>  cells at or over <n> characters neither set a column
    \\                     width nor get padding (default 100, minimum 3);
    \\                     --max-col=<n>, -m <n> and -m=<n> also work
    \\  -c, --check        write nothing and exit 1 when the input is not
    \\                     already aligned
    \\  -h, --help         show this help
    \\  -V, --version      show the version
    \\
    \\Exit codes:
    \\  0  the tables were written, or --check found the input aligned
    \\  1  a bad option, a file that cannot be read or written, or --check
    \\     found the input unaligned
    \\
;

/// Which way a separator cell points its column: `| :--- |` left, `| ---: |`
/// right, `| :---: |` centre, `| --- |` unchanged.
pub const Alignment = enum { none, left, right, center };

/// What `md-fix-tables.js`'s `parseArgs` returns, or the exact `Error.message`
/// it would throw (without the `Error: ` prefix or trailing newline).
pub const ArgsResult = union(enum) {
    ok: struct {
        /// `null`, or an empty string (falsy in JS), selects stdin/stdout mode.
        file_path: ?[]const u8,
        max_col: usize,
        /// `-c` / `--check`: report instead of writing.
        check: bool,
        /// `-h` / `--help` and `-V` / `--version` are recorded here and acted
        /// on by the caller, which decides the precedence; `--help` wins.
        help: bool,
        version: bool,
    },
    err: []const u8,
};

/// Read a whole file the way the CLI does: raw bytes, decoded as WHATWG UTF-8.
pub fn readInputFile(io: Io, alloc: Allocator, path: []const u8) ![]u8 {
    return Io.Dir.cwd().readFileAlloc(io, path, alloc, .unlimited);
}

/// Read all of stdin, the JS tool's `readStdin()`.
pub fn readAllStdin(io: Io, alloc: Allocator) ![]u8 {
    var buffer: [4096]u8 = undefined;
    var stdin = Io.File.Reader.init(.stdin(), io, &buffer);
    return stdin.interface.allocRemaining(alloc, .unlimited);
}

/// Decode bytes exactly like Node's `readFileSync(path, 'utf-8')` /
/// `Buffer.toString('utf8')`: the WHATWG Encoding "utf-8 decoder", where each
/// invalid maximal subpart becomes one U+FFFD, and a continuation byte that
/// does not fit is re-examined as a lead byte rather than consumed.
pub fn decodeUtf8(alloc: Allocator, bytes: []const u8) Allocator.Error![]u8 {
    if (std.unicode.utf8ValidateSlice(bytes)) return alloc.dupe(u8, bytes);

    const State = struct {
        /// Continuation bytes still expected.
        needed: usize = 0,
        /// Inclusive range the next byte must fall into.
        lower: u8 = 0x80,
        upper: u8 = 0xBF,
        /// The partial code point accumulated so far.
        cp: u21 = 0,
    };

    var out: std.ArrayList(u8) = .empty;
    var state: State = .{};
    var i: usize = 0;
    while (i < bytes.len) {
        const b = bytes[i];
        if (state.needed == 0) {
            if (b < 0x80) {
                try out.append(alloc, b);
                i += 1;
                continue;
            }
            switch (b) {
                0xC2...0xDF => state = .{ .needed = 1, .cp = b & 0x1F },
                0xE0 => state = .{ .needed = 2, .lower = 0xA0, .cp = b & 0x0F },
                0xE1...0xEC, 0xEE, 0xEF => state = .{ .needed = 2, .cp = b & 0x0F },
                0xED => state = .{ .needed = 2, .upper = 0x9F, .cp = b & 0x0F },
                0xF0 => state = .{ .needed = 3, .lower = 0x90, .cp = b & 0x07 },
                0xF1...0xF3 => state = .{ .needed = 3, .cp = b & 0x07 },
                0xF4 => state = .{ .needed = 3, .upper = 0x8F, .cp = b & 0x07 },
                // Stray continuation byte, C0/C1, or F5..FF: one replacement, consumed.
                else => try out.appendSlice(alloc, "\u{FFFD}"),
            }
            i += 1;
            continue;
        }
        if (b >= state.lower and b <= state.upper) {
            state.cp = (state.cp << 6) | (b & 0x3F);
            state.needed -= 1;
            // Only the first continuation after a lead can be restricted.
            state.lower = 0x80;
            state.upper = 0xBF;
            if (state.needed == 0) {
                var buf: [4]u8 = undefined;
                // The lead-byte ranges above make surrogates and out-of-range
                // code points impossible, so encoding cannot fail.
                const n = std.unicode.utf8Encode(state.cp, &buf) catch unreachable;
                try out.appendSlice(alloc, buf[0..n]);
                state = .{};
            }
            i += 1;
            continue;
        }
        // Out-of-range continuation: one replacement, and the byte is
        // reprocessed as a potential new lead byte (not consumed here).
        try out.appendSlice(alloc, "\u{FFFD}");
        state = .{};
    }
    // A truncated sequence at end of input is one replacement.
    if (state.needed > 0) try out.appendSlice(alloc, "\u{FFFD}");
    return out.toOwnedSlice(alloc);
}

// ---------------------------------------------------------------------------
// JS string semantics
// ---------------------------------------------------------------------------

const CodeUnit = struct { value: u21, len: usize };

/// Decode the UTF-8 code point starting at `s[i]`. Malformed input decodes as
/// one byte of U+FFFD; CLI input is WHATWG-decoded first, so that path only
/// guards direct library use.
fn decodeAt(s: []const u8, i: usize) CodeUnit {
    const b = s[i];
    if (b < 0x80) return .{ .value = b, .len = 1 };
    const len = std.unicode.utf8ByteSequenceLength(b) catch
        return .{ .value = 0xFFFD, .len = 1 };
    if (i + len > s.len) return .{ .value = 0xFFFD, .len = 1 };
    const value = std.unicode.utf8Decode(s[i .. i + len]) catch
        return .{ .value = 0xFFFD, .len = 1 };
    return .{ .value = value, .len = len };
}

/// The exact set of code points ECMAScript `String.prototype.trim` (and
/// `parseInt` leading-whitespace skipping) removes.
fn isJsWhitespace(cp: u21) bool {
    return switch (cp) {
        // TAB, LF, VT, FF, CR, SPACE
        0x09...0x0D,
        0x20,
        // NBSP, OGHAM SPACE MARK, EN QUAD..HAIR SPACE
        0xA0,
        0x1680,
        0x2000...0x200A,
        // LINE SEPARATOR, PARAGRAPH SEPARATOR, NNBSP, MMSP, IDEOGRAPHIC SPACE
        0x2028,
        0x2029,
        0x202F,
        0x205F,
        0x3000,
        // ZERO WIDTH NO-BREAK SPACE (BOM)
        0xFEFF,
        => true,
        else => false,
    };
}

/// JS `String.prototype.trim`: strip ECMAScript whitespace from both ends,
/// measuring in code points.
fn jsTrim(s: []const u8) []const u8 {
    var start: usize = 0;
    while (start < s.len) {
        const d = decodeAt(s, start);
        if (!isJsWhitespace(d.value)) break;
        start += d.len;
    }
    var end: usize = s.len;
    while (end > start) {
        var lead: usize = end - 1;
        while (lead > start and (s[lead] & 0xC0) == 0x80) lead -= 1;
        const d = decodeAt(s, lead);
        if (!isJsWhitespace(d.value)) break;
        end = lead;
    }
    return s[start..end];
}

/// JS `String.prototype.length`: the number of UTF-16 code units. Non-BMP code
/// points (astral emoji, CJK ext-B, ...) count as two.
fn jsLen(s: []const u8) usize {
    var len: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const d = decodeAt(s, i);
        len += if (d.value >= 0x10000) 2 else 1;
        i += d.len;
    }
    return len;
}

/// JS `Number.parseInt(value, 10)`; `null` stands in for JS `undefined`.
/// Leading ECMAScript whitespace and one sign are allowed, digits are read
/// until a non-digit, and anything after them is ignored. Returns `null` for
/// NaN. Accumulation saturates: JS keeps counting in double precision, and any
/// value that large is behaviourally just "wider than every cell".
fn jsParseInt(value: ?[]const u8) ?i64 {
    const s = value orelse return null;
    var i: usize = 0;
    while (i < s.len) {
        const d = decodeAt(s, i);
        if (!isJsWhitespace(d.value)) break;
        i += d.len;
    }
    var negative = false;
    if (i < s.len and (s[i] == '+' or s[i] == '-')) {
        negative = s[i] == '-';
        i += 1;
    }
    var n: i64 = 0;
    var any = false;
    while (i < s.len and s[i] >= '0' and s[i] <= '9') : (i += 1) {
        any = true;
        n = n *| 10 +| (s[i] - '0');
    }
    if (!any) return null;
    return if (negative) -n else n;
}

/// JS `String.prototype.split('\n')`: always exactly one more piece than there
/// are separators, so `""` is one empty line and `"a\n"` is `{"a", ""}`.
fn splitLines(alloc: Allocator, content: []const u8) Allocator.Error![][]const u8 {
    var lines: std.ArrayList([]const u8) = .empty;
    var start: usize = 0;
    for (content, 0..) |ch, i| {
        if (ch == '\n') {
            try lines.append(alloc, content[start..i]);
            start = i + 1;
        }
    }
    try lines.append(alloc, content[start..]);
    return lines.toOwnedSlice(alloc);
}

fn joinLines(alloc: Allocator, lines: []const []const u8) Allocator.Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    for (lines, 0..) |line, i| {
        if (i > 0) try out.append(alloc, '\n');
        try out.appendSlice(alloc, line);
    }
    return out.toOwnedSlice(alloc);
}

// ---------------------------------------------------------------------------
// Table parsing
// ---------------------------------------------------------------------------

/// A line is part of a table when its first non-space character is a pipe
/// (JS `line.trim().startsWith('|')`).
fn isTableLine(line: []const u8) bool {
    const trimmed = jsTrim(line);
    return trimmed.len > 0 and trimmed[0] == '|';
}

/// The leading run of spaces and tabs: the table's own indentation, which a row
/// keeps so a table inside a list item stays inside it (JS `indentOf`).
fn indentOf(line: []const u8) []const u8 {
    for (line, 0..) |ch, i| {
        if (ch != ' ' and ch != '\t') return line[0..i];
    }
    return line;
}

/// The column a list item's content starts at, or null when the line is not a
/// list item (JS `listMarkerWidth`). `- x` puts its content at column 2, so a
/// table indented four spaces under it sits at the item's own indentation 2 and
/// is a table, not an indented code block. (Approximation: the marker plus one
/// space, and tabs count as one column, which is enough for the documents this
/// tool meets.)
fn listMarkerWidth(line: []const u8) ?usize {
    const i = indentOf(line).len;
    if (i >= line.len) return null;
    if (line[i] == '-' or line[i] == '*' or line[i] == '+') {
        const j = i + 1;
        if (j >= line.len or (line[j] != ' ' and line[j] != '\t')) return null;
        return j + 1;
    }
    var k = i;
    var digits: usize = 0;
    while (k < line.len and digits < 9 and line[k] >= '0' and line[k] <= '9') : (k += 1) digits += 1;
    if (digits == 0) return null;
    if (k >= line.len or (line[k] != '.' and line[k] != ')')) return null;
    const j = k + 1;
    if (j >= line.len or (line[j] != ' ' and line[j] != '\t')) return null;
    return j + 1;
}

/// A fenced code block marker: three or more backticks or tildes, indented or
/// not, with the rest of the line after the run (JS `fenceMarker`). CommonMark: a
/// backtick fence's info string may not contain a backtick, and a closing fence
/// has nothing but spaces after it.
const FenceMarker = struct { char: u8, len: usize, rest: []const u8 };

fn fenceMarker(line: []const u8) ?FenceMarker {
    var i: usize = indentOf(line).len;
    if (i >= line.len) return null;
    const ch = line[i];
    if (ch != '`' and ch != '~') return null;
    const start = i;
    while (i < line.len and line[i] == ch) i += 1;
    if (i - start < 3) return null;
    return .{ .char = ch, .len = i - start, .rest = line[i..] };
}

/// CommonMark: a closing fence is the same character, at least as long, and
/// followed by nothing but spaces (JS `isFenceClose`).
fn isFenceClose(marker: ?FenceMarker, open: FenceMarker) bool {
    const m = marker orelse return false;
    return m.char == open.char and m.len >= open.len and jsTrim(m.rest).len == 0;
}

/// Everything between a fence and its closing marker is a code sample, never a
/// table (JS `opensFence`). A code sample that happens to show a table — or that
/// draws with `|`, or holds a Java `||` continuation — must survive a run
/// untouched.
fn opensFence(marker: ?FenceMarker) bool {
    const m = marker orelse return false;
    return m.char == '~' or std.mem.indexOfScalar(u8, m.rest, '`') == null;
}

const Row = []const []const u8;

/// One line of a table block: the text without its `\r`, and whether it had one.
const TableRow = struct { body: []const u8, cr: bool };

/// The line as it arrived: its body, and its `\r` if it had one (JS builds the
/// same string when it re-joins a block it did not align).
fn verbatimLine(arena: Allocator, row: TableRow) Allocator.Error![]const u8 {
    if (!row.cr) return row.body;
    const out = try arena.alloc(u8, row.body.len + 1);
    @memcpy(out[0..row.body.len], row.body);
    out[row.body.len] = '\r';
    return out;
}

/// How many columns the table has (JS `columnCount`). GFM: the header row and
/// the delimiter row declare them, and a row with more cells than that has its
/// excess *ignored* by the renderer — so the table is never widened to fit such a
/// row, which is what used to turn one unescaped `|` inside a cell into an extra
/// column for the whole table. A block whose row 2 is no delimiter row has only
/// its widest row to go on.
fn columnCount(table_data: []const Row) usize {
    if (table_data.len >= 2 and isSeparatorRow(table_data[1], 1)) {
        return @max(table_data[0].len, table_data[1].len);
    }
    var num_cols: usize = 0;
    for (table_data) |cells| num_cols = @max(num_cols, cells.len);
    return num_cols;
}

/// Split a row into trimmed cells. `\|` is an escaped pipe: it stays literal
/// and does not split the cell. A leading/trailing empty cell is the row's
/// outer pipe, and only one of each is dropped (JS `parseRow`).
fn parseRow(alloc: Allocator, row: []const u8) Allocator.Error!Row {
    var raw: std.ArrayList([]const u8) = .empty;
    var start: usize = 0;
    var escaped = false;
    for (row, 0..) |ch, i| {
        if (escaped) {
            escaped = false;
        } else if (ch == '\\') {
            escaped = true;
        } else if (ch == '|') {
            try raw.append(alloc, jsTrim(row[start..i]));
            start = i + 1;
        }
    }
    try raw.append(alloc, jsTrim(row[start..]));

    var cells: []const []const u8 = raw.items;
    if (cells.len > 0 and cells[0].len == 0) cells = cells[1..];
    if (cells.len > 0 and cells[cells.len - 1].len == 0) cells = cells[0 .. cells.len - 1];

    const out = try alloc.alloc([]const u8, cells.len);
    @memcpy(out, cells);
    return out;
}

/// JS `/^:?-{3,}:?$/` on a (trimmed) separator cell.
pub fn sepCellMatches(cell: []const u8) bool {
    var i: usize = 0;
    var end: usize = cell.len;
    if (end > 0 and cell[0] == ':') i += 1;
    if (end > i and cell[end - 1] == ':') end -= 1;
    if (end - i < MIN_COL) return false;
    for (cell[i..end]) |ch| if (ch != '-') return false;
    return true;
}

/// Row 2 is the separator row (standard GFM) when every cell matches
/// `SEP_CELL`.
fn isSeparatorRow(cells: Row, row_index: usize) bool {
    if (row_index != 1) return false;
    if (cells.len == 0) return false;
    for (cells) |cell| if (!sepCellMatches(cell)) return false;
    return true;
}

fn alignmentOf(cell: []const u8) Alignment {
    const left = cell.len > 0 and cell[0] == ':';
    const right = cell.len > 0 and cell[cell.len - 1] == ':';
    if (left and right) return .center;
    if (left) return .left;
    if (right) return .right;
    return .none;
}

/// Rebuild one separator cell at the column's width, keeping any alignment
/// markers (JS `separatorCell`). A colon occupies a character of the cell, so
/// the dashes give it room; at the 3-wide floor an aligned cell keeps two
/// dashes even though that makes `:--:` one character wider than its column.
fn appendSeparatorCell(
    out: *std.ArrayList(u8),
    alloc: Allocator,
    alignment: Alignment,
    width: usize,
) Allocator.Error!void {
    const dashes: usize = switch (alignment) {
        .none => width,
        .center => @max(width -| 2, 2),
        .left, .right => @max(width -| 1, 2),
    };
    if (alignment == .left or alignment == .center) try out.append(alloc, ':');
    try out.appendNTimes(alloc, '-', dashes);
    if (alignment == .right or alignment == .center) try out.append(alloc, ':');
}

// ---------------------------------------------------------------------------
// Table alignment
// ---------------------------------------------------------------------------

/// Align a table block (JS `alignTable`). Row 2's separator cells are
/// regenerated at each measured column width, keeping whatever alignment
/// (`:---`, `---:`, `:---:`) they declared; the colons stay inside the cell,
/// so every pipe still lands on the same index as the rows around it.
///
/// Each row is emitted at the block's own indentation and with its own line
/// ending, so a table keeps its place in a document and a CRLF file stays CRLF.
fn alignTable(alloc: Allocator, rows: []const TableRow, max_col: usize) Allocator.Error![]u8 {
    const table_data = try alloc.alloc(Row, rows.len);
    for (rows, 0..) |row, r| table_data[r] = try parseRow(alloc, row.body);

    const num_cols = columnCount(table_data);
    const indent = indentOf(rows[0].body);

    // The alignment row, for the columns it covers. A block whose row 2 is
    // not a separator row has no alignment to keep.
    const separator: ?Row =
        if (table_data.len >= 2 and isSeparatorRow(table_data[1], 1)) table_data[1] else null;
    const alignments = try alloc.alloc(Alignment, num_cols);
    for (alignments, 0..) |*slot, i| slot.* = if (separator) |sep|
        alignmentOf(if (i < sep.len) sep[i] else "")
    else
        .none;

    // Rule 1: a column's width is the longest content that is still under
    // max_col, so one huge cell cannot widen the column and force every
    // shorter cell to pad out to it. Row 2 is measured along with every other
    // row even though it is regenerated: counting the whole cell is what makes
    // the rebuilt separator exactly as wide as the one it replaces.
    //
    // Cells past `num_cols` are not measured at all: they are outside the table
    // the header declared, and the renderer does not show them.
    const col_widths = try alloc.alloc(usize, num_cols);
    const longest_cell = try alloc.alloc(usize, num_cols);
    @memset(col_widths, 0);
    @memset(longest_cell, 0);
    for (table_data) |cells| {
        for (cells, 0..) |cell, i| {
            if (i >= num_cols) break;
            const l = jsLen(cell);
            if (l > longest_cell[i]) longest_cell[i] = l;
            if (l < max_col and l > col_widths[i]) col_widths[i] = l;
        }
    }
    for (0..num_cols) |i| {
        // Every cell in this column was >= max_col: fall back to the widest, capped.
        if (col_widths[i] == 0) col_widths[i] = @min(longest_cell[i], max_col);
        if (col_widths[i] < MIN_COL) col_widths[i] = MIN_COL;
    }

    // Absolute position at which each cell's content should end, and therefore
    // where the next cell's content should begin.
    //   "| " starts cell 0 at 2, each cell is followed by " | " (3 chars).
    const ideal_end = try alloc.alloc(i64, num_cols);
    {
        var cursor: i64 = 2;
        for (0..num_cols) |i| {
            cursor += @as(i64, @intCast(col_widths[i]));
            ideal_end[i] = cursor;
            cursor += 3;
        }
    }

    var out: std.ArrayList(u8) = .empty;
    for (table_data, 0..) |cells, row_index| {
        if (row_index > 0) try out.append(alloc, '\n');
        try out.appendSlice(alloc, indent);

        if (isSeparatorRow(cells, row_index)) {
            try out.appendSlice(alloc, "| ");
            for (col_widths, 0..) |w, i| {
                if (i > 0) try out.appendSlice(alloc, " | ");
                try appendSeparatorCell(&out, alloc, alignments[i], w);
            }
            try out.appendSlice(alloc, " |");
        } else {
            // Rule 2: a cell may only pad as far as its own boundary. Once an
            // earlier oversized cell has pushed the row right, the remaining
            // padding is shrunk — and dropped entirely if the boundary is
            // already behind us — so the padding never carries this row
            // further into the next column's space.
            var pos: i64 = 2;
            try out.appendSlice(alloc, "| ");
            for (0..num_cols) |i| {
                if (i > 0) try out.appendSlice(alloc, " | ");
                const cell: []const u8 = if (i < cells.len) cells[i] else "";
                const cell_len: i64 = @as(i64, @intCast(jsLen(cell)));
                const len: i64 = @max(cell_len, ideal_end[i] - pos);
                try out.appendSlice(alloc, cell);
                if (len > cell_len) {
                    try out.appendNTimes(alloc, ' ', @as(usize, @intCast(len - cell_len)));
                }
                pos += len + 3;
            }
            // Cells past the declared columns are kept verbatim rather than
            // dropped: a renderer ignores them, and this tool never truncates a
            // line.
            if (cells.len > num_cols) {
                for (cells[num_cols..]) |cell| {
                    try out.appendSlice(alloc, " | ");
                    try out.appendSlice(alloc, cell);
                }
            }
            try out.appendSlice(alloc, " |");
        }

        if (rows[row_index].cr) try out.append(alloc, '\r');
    }
    return out.toOwnedSlice(alloc);
}

/// A block of one line is not a table: `|` alone on a line is prose, art, or the
/// tail of something else, and re-emitting it as `|  |` was the tool inventing a
/// table where the document had none (JS `flush`).
fn flushTable(
    arena: Allocator,
    pieces: *std.ArrayList([]const u8),
    table: *std.ArrayList(TableRow),
    max_col: usize,
) Allocator.Error!void {
    if (table.items.len >= 2) {
        try pieces.append(arena, try alignTable(arena, table.items, max_col));
    } else {
        for (table.items) |row| try pieces.append(arena, try verbatimLine(arena, row));
    }
    table.clearRetainingCapacity();
}

/// Re-align every pipe table in markdown text (JS `fixTables`). `max_col` is
/// the width at/above which a cell stops counting towards its column's width
/// (the JS default is `MAX_COL`, 100).
///
/// Lines are split on `\n` and a trailing `\r` is kept per line, so a CRLF
/// document stays CRLF. Three things are never a table, and each is copied
/// verbatim: a fenced code block, an indented code block (a run of lines at four
/// spaces or more, measured from whatever list item contains them, that begins
/// after a blank line), and a line that starts with `|` but is not part of a block
/// of at least two such lines.
pub fn fixTables(alloc: Allocator, content: []const u8, max_col: usize) Allocator.Error![]u8 {
    // All scratch lives in an arena so callers only own the returned slice.
    var scratch = std.heap.ArenaAllocator.init(alloc);
    defer scratch.deinit();
    const arena = scratch.allocator();

    const lines = try splitLines(arena, content);
    const rows = try arena.alloc(TableRow, lines.len);
    for (lines, 0..) |line, i| {
        rows[i] = if (line.len > 0 and line[line.len - 1] == '\r')
            .{ .body = line[0 .. line.len - 1], .cr = true }
        else
            .{ .body = line, .cr = false };
    }

    var pieces: std.ArrayList([]const u8) = .empty;
    var table: std.ArrayList(TableRow) = .empty;
    var open: ?FenceMarker = null; // the open fence marker while inside a code block
    var indented_code = false; // inside a run of indented code
    var container: usize = 0; // the column the enclosing list item's content starts at
    var after_blank = true; // the start of a document is a blank line for this purpose

    for (rows) |row| {
        const marker = fenceMarker(row.body);

        if (open != null) {
            if (isFenceClose(marker, open.?)) open = null;
            try flushTable(arena, &pieces, &table, max_col);
            try pieces.append(arena, try verbatimLine(arena, row));
            after_blank = false;
            continue;
        }
        if (opensFence(marker)) {
            try flushTable(arena, &pieces, &table, max_col);
            open = marker;
            try pieces.append(arena, try verbatimLine(arena, row));
            after_blank = false;
            continue;
        }

        // A blank line ends a table, and keeps an indented code block open (the
        // block ends at the next line that is indented less than four).
        if (jsTrim(row.body).len == 0) {
            try flushTable(arena, &pieces, &table, max_col);
            try pieces.append(arena, try verbatimLine(arena, row));
            after_blank = true;
            continue;
        }

        // An indented code block: four columns past whatever contains it, and only
        // where a paragraph could not be continuing — CommonMark's rule, which is
        // what "after a blank line" stands in for here.
        const indent = indentOf(row.body).len;
        if (indented_code) {
            if (indent >= container + 4) {
                try flushTable(arena, &pieces, &table, max_col);
                try pieces.append(arena, try verbatimLine(arena, row));
                after_blank = false;
                continue;
            }
            indented_code = false;
        }
        if (indent >= container + 4 and after_blank) {
            indented_code = true;
            try flushTable(arena, &pieces, &table, max_col);
            try pieces.append(arena, try verbatimLine(arena, row));
            after_blank = false;
            continue;
        }

        if (listMarkerWidth(row.body)) |width| {
            container = width;
        } else if (indent == 0) {
            container = 0;
        }

        after_blank = false;
        if (isTableLine(row.body)) {
            try table.append(arena, row);
            continue;
        }
        try flushTable(arena, &pieces, &table, max_col);
        try pieces.append(arena, try verbatimLine(arena, row));
    }
    try flushTable(arena, &pieces, &table, max_col);

    const out = try joinLines(arena, pieces.items);
    return alloc.dupe(u8, out);
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/// Parse the command line (JS `parseArgs`). Accepts a single file path plus an
/// optional width and the flags, in every spelling the JS tool accepts:
///
///   -c  --check    -h  --help    -V  --version
///   --max-col=<n>   --max-col <n>   -m <n>   -m=<n>
///
/// `argv` is the user arguments only (node's `process.argv.slice(2)`), and the
/// error strings match the JS `Error` messages exactly.
pub fn parseArgs(alloc: Allocator, argv: []const []const u8) Allocator.Error!ArgsResult {
    var max_col: usize = MAX_COL;
    var file_path: ?[]const u8 = null;
    var check = false;
    var help = false;
    var version = false;

    var i: usize = 0;
    while (i < argv.len) : (i += 1) {
        const arg = argv[i];
        var value: ?[]const u8 = null;

        if (std.mem.eql(u8, arg, "-c") or std.mem.eql(u8, arg, "--check")) {
            check = true;
            continue;
        }
        if (std.mem.eql(u8, arg, "-h") or std.mem.eql(u8, arg, "--help")) {
            help = true;
            continue;
        }
        if (std.mem.eql(u8, arg, "-V") or std.mem.eql(u8, arg, "--version")) {
            version = true;
            continue;
        }

        if (std.mem.startsWith(u8, arg, "--max-col=")) {
            value = arg["--max-col=".len..];
        } else if (std.mem.eql(u8, arg, "--max-col") or std.mem.eql(u8, arg, "-m")) {
            i += 1;
            value = if (i < argv.len) argv[i] else null;
        } else if (std.mem.startsWith(u8, arg, "-m=")) {
            value = arg["-m=".len..];
        } else if (arg.len == 0 or arg[0] != '-') {
            file_path = arg;
            continue;
        } else {
            return .{ .err = try std.fmt.allocPrint(alloc, "Unknown option: {s}", .{arg}) };
        }

        const parsed = jsParseInt(value);
        if (parsed == null or parsed.? < MIN_COL) {
            const shown: []const u8 = value orelse "undefined";
            return .{ .err = try std.fmt.allocPrint(
                alloc,
                "--max-col needs an integer >= {d}, got: {s}",
                .{ MIN_COL, shown },
            ) };
        }
        max_col = @intCast(parsed.?);
    }

    return .{ .ok = .{
        .file_path = file_path,
        .max_col = max_col,
        .check = check,
        .help = help,
        .version = version,
    } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

fn fixed(alloc: Allocator, content: []const u8, max_col: usize) ![]u8 {
    return fixTables(alloc, content, max_col);
}

test "jsTrim mirrors String.prototype.trim" {
    try testing.expectEqualStrings("|a", jsTrim(" \t\r\n|a"));
    try testing.expectEqualStrings("a", jsTrim("a\u{00A0}"));
    try testing.expectEqualStrings("a\u{200B}", jsTrim("a\u{200B}")); // ZWSP is not JS whitespace
    try testing.expectEqualStrings("|", jsTrim("\u{FEFF}|"));
    try testing.expectEqualStrings("", jsTrim(" \t\r\n\u{00A0}\u{3000}"));
    try testing.expectEqualStrings("a b", jsTrim("  a b  "));
}

test "jsLen counts UTF-16 code units" {
    try testing.expectEqual(@as(usize, 3), jsLen("abc"));
    try testing.expectEqual(@as(usize, 1), jsLen("中"));
    try testing.expectEqual(@as(usize, 2), jsLen("\u{1F600}"));
    try testing.expectEqual(@as(usize, 2), jsLen("a\u{0301}")); // combining mark keeps its own unit
    try testing.expectEqual(@as(usize, 0), jsLen(""));
}

test "jsParseInt mirrors Number.parseInt(x, 10)" {
    try testing.expectEqual(@as(?i64, 50), jsParseInt("50"));
    try testing.expectEqual(@as(?i64, 50), jsParseInt("50abc"));
    try testing.expectEqual(@as(?i64, 42), jsParseInt(" 42 "));
    try testing.expectEqual(@as(?i64, 5), jsParseInt("+5"));
    try testing.expectEqual(@as(?i64, -5), jsParseInt("-5"));
    try testing.expectEqual(@as(?i64, 0), jsParseInt("0x10"));
    try testing.expectEqual(@as(?i64, 1), jsParseInt("1e3"));
    try testing.expectEqual(@as(?i64, 9), jsParseInt("\u{00A0}9"));
    try testing.expectEqual(@as(?i64, null), jsParseInt(""));
    try testing.expectEqual(@as(?i64, null), jsParseInt("abc"));
    try testing.expectEqual(@as(?i64, null), jsParseInt("-"));
    try testing.expectEqual(@as(?i64, null), jsParseInt(null));
    // Saturating: still an integer >= 3 as far as the tool is concerned.
    try testing.expect(jsParseInt("999999999999999999999999").? >= 3);
}

test "sepCellMatches mirrors /^:?-{3,}:?$/" {
    for ([_][]const u8{ "---", ":---", "---:", ":---:", "-----:", ":----", "----------" }) |cell| {
        try testing.expect(sepCellMatches(cell));
    }
    for ([_][]const u8{ "", ":", "-", "--", ":-", "-:", ":--", "--x", "a---", "---a", ":---::", "- -", "----\t" }) |cell| {
        try testing.expect(!sepCellMatches(cell));
    }
}

test "parseRow splits, unescapes and trims like the JS helper" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const row = try parseRow(alloc, "| a | b |");
    try testing.expectEqual(@as(usize, 2), row.len);
    try testing.expectEqualStrings("a", row[0]);
    try testing.expectEqualStrings("b", row[1]);

    const ragged = try parseRow(alloc, "  |a|  ");
    try testing.expectEqual(@as(usize, 1), ragged.len);
    try testing.expectEqualStrings("a", ragged[0]);

    const escaped = try parseRow(alloc, "| a \\| b | c ");
    try testing.expectEqual(@as(usize, 2), escaped.len);
    try testing.expectEqualStrings("a \\| b", escaped[0]);
    try testing.expectEqualStrings("c", escaped[1]);

    const bare = try parseRow(alloc, "|");
    try testing.expectEqual(@as(usize, 0), bare.len);

    const empty_cell = try parseRow(alloc, "||");
    try testing.expectEqual(@as(usize, 1), empty_cell.len);
    try testing.expectEqualStrings("", empty_cell[0]);
}

/// Character index of every unescaped `|` in a line (the `pipes()` helper of
/// the JS test suite).
fn pipeIndexes(alloc: Allocator, line: []const u8) ![]usize {
    var indexes: std.ArrayList(usize) = .empty;
    var i: usize = 0;
    while (i < line.len) : (i += 1) {
        if (line[i] == '\\') {
            i += 1;
            continue;
        }
        if (line[i] == '|') try indexes.append(alloc, i);
    }
    return indexes.toOwnedSlice(alloc);
}

fn expectPipesEqual(alloc: Allocator, a: []const u8, b: []const u8) !void {
    const ia = try pipeIndexes(alloc, a);
    const ib = try pipeIndexes(alloc, b);
    try testing.expectEqualSlices(usize, ia, ib);
}

// --- fixtures --------------------------------------------------------------

/// Read a repo file from either the cwd (how `zig build test` and
/// `zig test src/root.zig` run) or a path derived from this source file.
fn readRepoFile(alloc: Allocator, io: Io, rel: []const u8) ![]u8 {
    const roots = [_][]const u8{
        ".",
        try std.fs.path.resolve(alloc, &.{
            std.fs.path.dirname(@src().file) orelse ".",
            "..",
        }),
    };
    for (roots) |root| {
        const full = try std.fs.path.join(alloc, &.{ root, rel });
        if (Io.Dir.cwd().readFileAlloc(io, full, alloc, .unlimited)) |bytes| {
            return bytes;
        } else |_| {}
    }
    return error.FileNotFound;
}

/// LF endings and no trailing newline: exactly the text between README's
/// fences (the `normalize()` of test-fixtures.js).
fn normalize(alloc: Allocator, text: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    for (text) |ch| {
        if (ch == '\r') continue; // fixtures use CRLF only as \r\n pairs
        try out.append(alloc, ch);
    }
    var slice: []const u8 = out.items;
    if (slice.len > 0 and slice[slice.len - 1] == '\n') slice = slice[0 .. slice.len - 1];
    return alloc.dupe(u8, slice);
}

/// The `table` region of fixtures/example-4/source.md, per the README's
/// `<!-- #region table -->` markers.
fn example4Before(alloc: Allocator, io: Io) ![]u8 {
    const source = try readRepoFile(alloc, io, "fixtures/example-4/source.md");
    const lines = try splitLines(alloc, source);
    var start: usize = 0;
    var end: usize = lines.len;
    for (lines, 0..) |line, i| {
        if (std.mem.eql(u8, jsTrim(line), "<!-- #region table -->")) start = i + 1;
        if (std.mem.eql(u8, jsTrim(line), "<!-- #endregion -->")) end = i;
    }
    return normalize(alloc, try joinLines(alloc, lines[start..end]));
}

const EXAMPLE_MAX_COL = 25;

test "fixtures: fixTables(before) === after for every example" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    for (0..5) |n| {
        const id = try std.fmt.allocPrint(alloc, "example-{d}", .{n + 1});
        var before: []u8 = undefined;
        if (n == 3) {
            before = try example4Before(alloc, testing.io);
        } else {
            before = try normalize(alloc, try readRepoFile(alloc, testing.io, try std.fmt.allocPrint(
                alloc,
                "fixtures/{s}/before.md",
                .{id},
            )));
        }
        const after = try normalize(alloc, try readRepoFile(alloc, testing.io, try std.fmt.allocPrint(
            alloc,
            "fixtures/{s}/after.md",
            .{id},
        )));

        const got = try fixed(alloc, before, EXAMPLE_MAX_COL);
        try testing.expectEqualStrings(after, got);
    }
}

test "fixtures: re-running is idempotent" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    for (0..5) |n| {
        const id = try std.fmt.allocPrint(alloc, "example-{d}", .{n + 1});
        const after = try normalize(alloc, try readRepoFile(alloc, testing.io, try std.fmt.allocPrint(
            alloc,
            "fixtures/{s}/after.md",
            .{id},
        )));
        const again = try fixed(alloc, after, EXAMPLE_MAX_COL);
        try testing.expectEqualStrings(after, again);
    }
}

// --- fixTables unit tests (ported from test-fix-tables.test.js) ------------

test "lines that do not start with a pipe are copied verbatim" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const input = "# Title\n" ++
        "\n" ++
        "A | B\n" ++
        "--- | ---\n" ++
        "1 | 2\n" ++
        "\n" ++
        "trailing prose";
    try testing.expectEqualStrings(input, try fixed(alloc, input, MAX_COL));
}

test "a block whose row 2 is not a separator is still aligned, but gets no separator" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const input = "| A | B |\n| 1 | 2 |\n| 3 | 4 |";
    const after = try splitLines(alloc, try fixed(alloc, input, MAX_COL));

    try testing.expectEqual(@as(usize, 3), after.len);
    for (after) |line| try expectPipesEqual(alloc, line, after[0]);
    try testing.expectEqualStrings("| 1   | 2   |", after[1]);
}

test "every row ends its columns on the same pipe indexes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const before = try normalize(alloc, try readRepoFile(alloc, testing.io, "fixtures/example-1/before.md"));
    const after = try splitLines(alloc, try fixed(alloc, before, EXAMPLE_MAX_COL));
    const expected = [_]usize{ 0, 8, 23, 44 };

    try testing.expectEqualSlices(usize, &expected, try pipeIndexes(alloc, after[0]));
    for (after) |line| {
        try testing.expectEqualSlices(usize, &expected, try pipeIndexes(alloc, line));
    }
}

test "Rule 1: a cell at or over the limit does not widen its column" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const huge = "x" ** 150;
    const before = try std.fmt.allocPrint(alloc, "| ID | Summary |\n| --- | --- |\n| 1 | {s} |\n| 2 | Short. |", .{huge});
    const after = try splitLines(alloc, try fixed(alloc, before, MAX_COL));

    // The short row still aligns with the header: the huge cell was ignored.
    try expectPipesEqual(alloc, after[3], after[0]);
    // ...and the huge cell is the only thing that runs long.
    try testing.expect(std.mem.indexOf(u8, after[2], huge) != null);
    const long_row = try pipeIndexes(alloc, after[2]);
    const header = try pipeIndexes(alloc, after[0]);
    try testing.expect(long_row[2] > header[2]);
}

test "Rule 2: padding after an overrun returns to the column boundary" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const before = try normalize(alloc, try readRepoFile(alloc, testing.io, "fixtures/example-3/before.md"));
    const after = try splitLines(alloc, try fixed(alloc, before, EXAMPLE_MAX_COL));
    const last = (try pipeIndexes(alloc, after[0])).len - 1;

    for (after) |line| {
        const pipes = try pipeIndexes(alloc, line);
        try testing.expectEqual(pipes[last], pipes[pipes.len - 1]);
    }
    // The delimiter right after the oversized cell is the one that moves...
    const long_row = try pipeIndexes(alloc, after[3]);
    const sep_row = try pipeIndexes(alloc, after[1]);
    try testing.expect(long_row[2] > sep_row[2]);
    // ...and these are the indexes the README quotes for example 3.
    try testing.expectEqualSlices(usize, &[_]usize{ 0, 6, 33, 57 }, try pipeIndexes(alloc, after[2]));
    try testing.expectEqualSlices(usize, &[_]usize{ 0, 6, 45, 57 }, long_row);
}

test "content is never truncated" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const before = try normalize(alloc, try readRepoFile(alloc, testing.io, "fixtures/example-3/before.md"));
    const after = try fixed(alloc, before, EXAMPLE_MAX_COL);

    for (try splitLines(alloc, before)) |line| {
        var rest: []const u8 = line;
        while (std.mem.indexOfScalar(u8, rest, '|')) |bar| {
            const cell = jsTrim(rest[0..bar]);
            if (cell.len > 0) try testing.expect(std.mem.indexOf(u8, after, cell) != null);
            rest = rest[bar + 1 ..];
        }
        const cell = jsTrim(rest);
        if (cell.len > 0) try testing.expect(std.mem.indexOf(u8, after, cell) != null);
    }
}

test "a row with fewer cells gets empty cells appended" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const before = try normalize(alloc, try readRepoFile(alloc, testing.io, "fixtures/example-2/before.md"));
    const after = try splitLines(alloc, try fixed(alloc, before, EXAMPLE_MAX_COL));
    try testing.expectEqualStrings("| 1    | Cut the release branch  |       |", after[2]);
}

test "the separator is regenerated with at least MIN_COL dashes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const after = try splitLines(alloc, try fixed(alloc, "| Name | Role |\n| --- | --- |\n| Ada | Engineer |", MAX_COL));
    try testing.expectEqualStrings("| ---- | -------- |", after[1]);
    for (after[1][1 .. after[1].len - 1]) |c| try testing.expect(c == '-' or c == ' ' or c == '|');
}

test "alignment colons are preserved" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const after = try splitLines(alloc, try fixed(alloc, "| A | B |\n| :--- | ---: |\n| 1 | 2 |", MAX_COL));

    // Left and right alignment keep their colon on its own side, and the
    // separator cell stays the same width as the column it heads.
    try testing.expectEqualStrings("| :--- | ---: |", after[1]);
    try testing.expectEqualStrings("| A    | B    |", after[0]);
    for (after) |line| {
        try testing.expectEqualSlices(usize, &[_]usize{ 0, 7, 14 }, try pipeIndexes(alloc, line));
    }
}

test "every alignment survives: left, right, centre and plain" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const before = "| Left | Right | Centre | Plain |\n| :--- | ---: | :---: | --- |\n| 1 | 2 | 3 | 4 |";
    const after = try splitLines(alloc, try fixed(alloc, before, MAX_COL));

    try testing.expectEqualStrings("| :--- | ----: | :----: | ----- |", after[1]);
    for (after) |line| {
        try testing.expectEqualSlices(usize, &[_]usize{ 0, 7, 15, 24, 32 }, try pipeIndexes(alloc, line));
    }
}

test "a separator wider than the content keeps its columns aligned" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const before = "| A | B |\n| :--- | :---: |\n| 1 | 2 |";
    const after = try fixed(alloc, before, MAX_COL);

    // The `:---:` cell is five characters wide, so its column measures five
    // even though the text above it is one character.
    try testing.expectEqualStrings(
        "| A    | B     |\n| :--- | :---: |\n| 1    | 2     |",
        after,
    );
}

test "a narrow aligned column keeps two dashes beside its colon" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const after = try fixed(alloc, "| A | B |\n| :--- | ---: |", MAX_COL);
    try testing.expectEqualStrings("| A    | B    |\n| :--- | ---: |", after);
    try testing.expectEqualStrings(after, try fixed(alloc, after, MAX_COL));
}

test "a 3-wide column keeps a legal colon form" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    try testing.expectEqualStrings("| A   |\n| :-- |", try fixed(alloc, "| A |\n| :-- |", MAX_COL));
}

test "a table with no alignment markers gains none" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const after = try fixed(alloc, "| A | B |\n| --- | --- |\n| 1 | 2 |", MAX_COL);
    try testing.expect(std.mem.indexOfScalar(u8, after, ':') == null);
}

test "preserved alignment is idempotent" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const before = "| Left | Right | Centre | Plain |\n| :--- | ---: | :---: | --- |\n| 1 | 2 | 3 | 4 |";
    const once = try fixed(alloc, before, MAX_COL);
    try testing.expectEqualStrings(once, try fixed(alloc, once, MAX_COL));
}

test "an escaped pipe does not split its cell" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const before = "| Pattern | Meaning |\n| --- | --- |\n| a \\| b | alternation |";
    const after = try splitLines(alloc, try fixed(alloc, before, MAX_COL));

    try testing.expect(std.mem.indexOf(u8, after[2], "a \\| b") != null);
    try expectPipesEqual(alloc, after[2], after[0]);
}

test "a shorter max column width ignores more cells" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const before = try std.fmt.allocPrint(alloc, "| A | B |\n| --- | --- |\n| {s} | short |", .{"x" ** 20});

    // With the default 100, the 20-char cell sets the width of column A.
    try testing.expectEqualStrings(
        "| A" ++ (" " ** 20) ++ "| B" ++ (" " ** 5) ++ "|",
        (try splitLines(alloc, try fixed(alloc, before, MAX_COL)))[0],
    );
    // With max_col = 10, it is ignored and the header alone sets the width.
    try testing.expectEqualStrings(
        "| A   | B     |",
        (try splitLines(alloc, try fixed(alloc, before, 10)))[0],
    );
}

test "MAX_COL is 100" {
    try testing.expectEqual(@as(usize, 100), MAX_COL);
}

// --- Zig-side extras: JS semantics the JS suite covers only implicitly ------

test "astral-plane cells pad in UTF-16 units like JS" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // The emoji is one code point but two UTF-16 units, so its column behaves
    // like a two-character cell, not a one-character one.
    const before = "| a | b |\n| --- | --- |\n| \u{1F600} | c |";
    const after = try fixed(alloc, before, MAX_COL);
    try testing.expectEqualStrings(
        "| a   | b   |\n| --- | --- |\n| \u{1F600}  | c   |",
        after,
    );
}

test "CRLF table rows keep their CR, like every other line" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // Each line keeps the ending it arrived with: a formatter must not turn the
    // rows of a CRLF document into LF and leave the rest of the file CRLF.
    const before = "prose\r\n| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\ntail\r\n";
    try testing.expectEqualStrings(
        "prose\r\n| a   | b   |\r\n| --- | --- |\r\n| 1   | 2   |\r\ntail\r\n",
        try fixed(alloc, before, MAX_COL),
    );

    // Mixed endings stay mixed: a row is re-emitted with its own, not its
    // neighbours'.
    const mixed = "| a | b |\r\n| --- | --- |\n| 1 | 2 |\r\n";
    try testing.expectEqualStrings(
        "| a   | b   |\r\n| --- | --- |\n| 1   | 2   |\r\n",
        try fixed(alloc, mixed, MAX_COL),
    );
}

test "a fenced code block is never a table" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // A code sample showing a table, and a diagram drawn with pipes, and a Java
    // `||` continuation: all three came back rewritten before this.
    const sample = "before:\n\n```markdown\n| A | B |\n|---|---|\n| 1 | 2 |\n```\n";
    try testing.expectEqualStrings(sample, try fixed(alloc, sample, MAX_COL));

    const diagram = "flow:\n\n~~~\nstart\n   |\n   v\nend\n~~~\n";
    try testing.expectEqualStrings(diagram, try fixed(alloc, diagram, MAX_COL));

    const java = "```java\nassertTrue(a.contains(\"x\")\n        || b.contains(\"y\"));\n```\n";
    try testing.expectEqualStrings(java, try fixed(alloc, java, MAX_COL));

    // A fence closes only on its own character, at least as long: a longer run
    // of tildes inside a backtick fence is content.
    const nested = "```\n| a | b |\n~~~\n| c | d |\n```\n";
    try testing.expectEqualStrings(nested, try fixed(alloc, nested, MAX_COL));

    // An unclosed fence swallows the rest of the document.
    const unclosed = "```\n| a | b |\n| --- | --- |\n";
    try testing.expectEqualStrings(unclosed, try fixed(alloc, unclosed, MAX_COL));

    // ...and a table *around* a fence is still aligned on both sides.
    const around = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```\n| x | y |\n```\n\n| c | d |\n| --- | --- |\n";
    try testing.expectEqualStrings(
        "| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\n```\n| x | y |\n```\n\n| c   | d   |\n| --- | --- |\n",
        try fixed(alloc, around, MAX_COL),
    );
}

test "a row keeps its own indentation, so a table stays inside its list item" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const nested = "- item\n\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |\n";
    try testing.expectEqualStrings(
        "- item\n\n  | A   | B   |\n  | --- | --- |\n  | 1   | 2   |\n",
        try fixed(alloc, nested, MAX_COL),
    );

    // The block's indentation is the first row's; a ragged row follows it.
    const ragged = "\t| A | B |\n\t| --- | --- |\n| 1 | 2 |\n";
    try testing.expectEqualStrings(
        "\t| A   | B   |\n\t| --- | --- |\n\t| 1   | 2   |\n",
        try fixed(alloc, ragged, MAX_COL),
    );
}

test "a row with more cells than the header never widens the table" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // The unescaped pipe in the code span splits that cell (GFM does the same),
    // and the renderer ignores the excess cell — so the header keeps its three
    // columns and the extra cell is left where it is, unpadded, not dropped.
    const before = "| A | B | C |\n| --- | --- | --- |\n| code | `x | y` | note |\n";
    try testing.expectEqualStrings(
        "| A    | B   | C   |\n| ---- | --- | --- |\n| code | `x  | y`  | note |\n",
        try fixed(alloc, before, MAX_COL),
    );

    // Fewer cells than the header is the documented other half: appended empty.
    const fewer = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |\n";
    try testing.expectEqualStrings(
        "| A   | B   | C   |\n| --- | --- | --- |\n| 1   | 2   |     |\n",
        try fixed(alloc, fewer, MAX_COL),
    );
}

test "a lone pipe line is not a table" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // A block of one line is prose, art, or the tail of something else. It used
    // to come back as `|  |`.
    try testing.expectEqualStrings("text\n\n   |\n\nmore text\n", try fixed(alloc, "text\n\n   |\n\nmore text\n", MAX_COL));
    try testing.expectEqualStrings("|", try fixed(alloc, "|", MAX_COL));
}

test "an indented code block is never a table" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // Four spaces after a blank line is CommonMark's indented code block, and a
    // code sample that shows a table must come through byte for byte.
    const block = "text\n\n    | A | B |\n    | --- | --- |\n    | 1 | 2 |\n";
    try testing.expectEqualStrings(block, try fixed(alloc, block, MAX_COL));

    // It runs to the first line indented less than four, blank lines inside it
    // included.
    const open = "text\n\n    | A | B |\n\n    | --- | --- |\ntail\n";
    try testing.expectEqualStrings(open, try fixed(alloc, open, MAX_COL));

    // At the very start of a document, with no blank line before it.
    const first = "    | A | B |\n    | --- | --- |\n";
    try testing.expectEqualStrings(first, try fixed(alloc, first, MAX_COL));

    // A line indented four spaces with no blank line before it is a paragraph
    // continuation, not code - an indented code block cannot interrupt one.
    const after_text = "text\n    | A | B |\n    | --- | --- |\n";
    const fixed_after_text = try fixed(alloc, after_text, MAX_COL);
    try testing.expect(!std.mem.eql(u8, after_text, fixed_after_text));
}

test "a table indented inside a list item is still a table" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // `- ` puts the item's content at column 2, so four spaces is the item's own
    // indentation 2 - a table, and it keeps its place in the item.
    const nested = "- item\n\n    | A | B |\n    | --- | --- |\n    | 1 | 2 |\n";
    try testing.expectEqualStrings(
        "- item\n\n    | A   | B   |\n    | --- | --- |\n    | 1   | 2   |\n",
        try fixed(alloc, nested, MAX_COL),
    );

    // Six spaces under `- ` is four past the item's content, so that one *is* an
    // indented code block inside the item.
    const code = "- item\n\n      | A | B |\n      | --- | --- |\n";
    try testing.expectEqualStrings(code, try fixed(alloc, code, MAX_COL));

    // An ordered marker is wider, so its content starts at column 3.
    const ordered = "1. item\n\n   | A | B |\n   | --- | --- |\n";
    try testing.expectEqualStrings(
        "1. item\n\n   | A   | B   |\n   | --- | --- |\n",
        try fixed(alloc, ordered, MAX_COL),
    );
}

test "fixTables on empty and separator-only input" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    try testing.expectEqualStrings("", try fixed(alloc, "", MAX_COL));
    try testing.expectEqualStrings("\n", try fixed(alloc, "\n", MAX_COL));
    try testing.expectEqualStrings("|", try fixed(alloc, "|", MAX_COL));
    try testing.expectEqualStrings("a", try fixed(alloc, "a", MAX_COL));
}

test "decodeUtf8 replaces invalid bytes like Node's utf-8 decoding" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const Case = struct { in: []const u8, out: []const u8 };
    const cases = [_]Case{
        .{ .in = "\x80", .out = "\u{FFFD}" },
        .{ .in = "\xC0", .out = "\u{FFFD}" },
        .{ .in = "\xC2", .out = "\u{FFFD}" },
        .{ .in = "\xE0", .out = "\u{FFFD}" },
        .{ .in = "\xE0\xA0", .out = "\u{FFFD}" },
        .{ .in = "\xED\xA0\x80", .out = "\u{FFFD}\u{FFFD}\u{FFFD}" }, // CESU-8 surrogate
        .{ .in = "\xF0", .out = "\u{FFFD}" },
        .{ .in = "\xF0\x80", .out = "\u{FFFD}\u{FFFD}" },
        .{ .in = "\xF4\x90\x80\x80", .out = "\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}" }, // > U+10FFFF
        .{ .in = "\xF5", .out = "\u{FFFD}" },
        .{ .in = "\xFF", .out = "\u{FFFD}" },
        .{ .in = "\xC2\x41", .out = "\u{FFFD}A" },
        .{ .in = "\xE0\x41", .out = "\u{FFFD}A" },
        .{ .in = "\xE1\x41", .out = "\u{FFFD}A" },
        .{ .in = "\xF0\x41", .out = "\u{FFFD}A" },
        .{ .in = "\xE1\x80\x41", .out = "\u{FFFD}A" },
        .{ .in = "\xF1\x80\x41", .out = "\u{FFFD}A" },
        .{ .in = "\xF1\x80\x80\x41", .out = "\u{FFFD}A" },
        .{ .in = "\xF0\x9F\x98", .out = "\u{FFFD}" }, // truncated emoji
        .{ .in = "\xEF\xBF\xBD", .out = "\u{FFFD}" },
        .{ .in = "\xED\x9F\xBF", .out = "\u{D7FF}" },
        .{ .in = "\xF0\x9F\x98\x80", .out = "\u{1F600}" },
        .{ .in = "\xC2\xC2\x80", .out = "\u{FFFD}\u{80}" }, // C2 80 is a valid U+0080
        .{ .in = "\xE0\x9F\x80", .out = "\u{FFFD}\u{FFFD}\u{FFFD}" },
        .{ .in = "\xE1\x9F\x80\x80", .out = "\u{17C0}\u{FFFD}" },
        .{ .in = "\xF4\x8F\xBF\xBF", .out = "\u{10FFFF}" },
        .{ .in = "\xF4\x90", .out = "\u{FFFD}\u{FFFD}" },
        .{ .in = "A\xC3", .out = "A\u{FFFD}" },
        .{ .in = "\x41\xF0\x9F\x98\x80\x42", .out = "A\u{1F600}B" },
    };
    for (cases) |case| {
        try testing.expectEqualStrings(case.out, try decodeUtf8(alloc, case.in));
    }
}

// --- parseArgs (ported from test-fix-tables.test.js) ------------------------

fn expectOk(alloc: Allocator, argv: []const []const u8, file_path: ?[]const u8, max_col: usize) !void {
    const result = try parseArgs(alloc, argv);
    try testing.expect(result == .ok);
    try testing.expectEqualStrings(file_path orelse "", result.ok.file_path orelse "");
    try testing.expectEqual(max_col, result.ok.max_col);
    // No flag is set unless a test says so through `expectFlags`.
    try testing.expect(!result.ok.check and !result.ok.help and !result.ok.version);
}

/// The `-c`, `-h` and `-V` flags of a parse, with no file path and MAX_COL.
fn expectFlags(alloc: Allocator, argv: []const []const u8, check: bool, help: bool, version: bool) !void {
    const result = try parseArgs(alloc, argv);
    try testing.expect(result == .ok);
    try testing.expect(result.ok.file_path == null);
    try testing.expectEqual(MAX_COL, result.ok.max_col);
    try testing.expectEqual(check, result.ok.check);
    try testing.expectEqual(help, result.ok.help);
    try testing.expectEqual(version, result.ok.version);
}

fn expectErr(alloc: Allocator, argv: []const []const u8, message: []const u8) !void {
    const result = try parseArgs(alloc, argv);
    try testing.expect(result == .err);
    try testing.expectEqualStrings(message, result.err);
}

test "parseArgs: defaults" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    try expectOk(alloc, &.{}, null, MAX_COL);
}

test "parseArgs: reads the file path" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    try expectOk(alloc, &.{"notes.md"}, "notes.md", MAX_COL);
}

test "parseArgs: accepts every spelling of max-col" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    try expectOk(alloc, &.{"--max-col=50"}, null, 50);
    try expectOk(alloc, &.{ "--max-col", "50" }, null, 50);
    try expectOk(alloc, &.{ "-m", "50" }, null, 50);
    try expectOk(alloc, &.{"-m=50"}, null, 50);
    try expectOk(alloc, &.{"--max-col=50x"}, null, 50);
    try expectOk(alloc, &.{"--max-col=+5"}, null, 5);
}

test "parseArgs: keeps the file path and the option together" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    try expectOk(alloc, &.{ "--max-col=50", "notes.md" }, "notes.md", 50);
    try expectOk(alloc, &.{ "a.md", "b.md" }, "b.md", MAX_COL);
    try expectOk(alloc, &.{ "--max-col=5", "--max-col=7" }, null, 7);
}

test "parseArgs: rejects bad values and unknown options" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    try expectErr(alloc, &.{"--max-col=2"}, "--max-col needs an integer >= 3, got: 2");
    try expectErr(alloc, &.{"--max-col=abc"}, "--max-col needs an integer >= 3, got: abc");
    try expectErr(alloc, &.{"--max-col=-5"}, "--max-col needs an integer >= 3, got: -5");
    try expectErr(alloc, &.{"-m="}, "--max-col needs an integer >= 3, got: ");
    try expectErr(alloc, &.{"--max-col"}, "--max-col needs an integer >= 3, got: undefined");
    try expectErr(alloc, &.{"--nope"}, "Unknown option: --nope");
    try expectErr(alloc, &.{"-"}, "Unknown option: -");
}

test "parseArgs: accepts -c, -h and -V in both spellings" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    try expectFlags(alloc, &.{"-c"}, true, false, false);
    try expectFlags(alloc, &.{"--check"}, true, false, false);
    try expectFlags(alloc, &.{"-h"}, false, true, false);
    try expectFlags(alloc, &.{"--help"}, false, true, false);
    try expectFlags(alloc, &.{"-V"}, false, false, true);
    try expectFlags(alloc, &.{"--version"}, false, false, true);
}

test "parseArgs: flags combine with a file path and a width" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const result = try parseArgs(alloc, &.{ "--check", "--max-col=25", "notes.md" });
    try testing.expect(result == .ok);
    try testing.expectEqualStrings("notes.md", result.ok.file_path.?);
    try testing.expectEqual(@as(usize, 25), result.ok.max_col);
    try testing.expect(result.ok.check and !result.ok.help and !result.ok.version);

    // Repeats and order do not matter, and all three can be set at once: the
    // caller resolves help before version before the work itself.
    try expectFlags(alloc, &.{ "-c", "-c" }, true, false, false);
    try expectFlags(alloc, &.{ "-V", "--help" }, false, true, true);
    try expectErr(alloc, &.{ "--help", "--nope" }, "Unknown option: --nope");
    try expectErr(alloc, &.{ "-c", "--max-col=2" }, "--max-col needs an integer >= 3, got: 2");

    // A flag after the file path belongs to the same command line.
    const flag_last = try parseArgs(alloc, &.{ "notes.md", "-c" });
    try testing.expect(flag_last == .ok);
    try testing.expectEqualStrings("notes.md", flag_last.ok.file_path.?);
    try testing.expect(flag_last.ok.check);
}

test "VERSION and HELP are non-empty and end in a newline" {
    try testing.expect(VERSION.len > 0);
    try testing.expect(HELP.len > 0);
    try testing.expectEqual(@as(u8, '\n'), HELP[HELP.len - 1]);
    try testing.expect(std.mem.startsWith(u8, HELP, "md-fix-tables — re-align"));
    try testing.expect(std.mem.endsWith(u8, HELP, "found the input unaligned\n"));
}
