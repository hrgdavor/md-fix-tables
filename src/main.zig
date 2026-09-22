//! `md-fix-tables` CLI — the Zig twin of `md-fix-tables.js`.
//!
//! File mode rewrites the file in place and prints nothing; with no file
//! argument (or an empty one, which is falsy in JS) it reads stdin and writes
//! the aligned result to stdout. Failures print `Error: <message>` on stderr
//! and exit 1, with the same messages the JS tool produces.

const std = @import("std");
const Io = std.Io;
const md_fix_tables = @import("md_fix_tables");

pub fn main(init: std.process.Init) !void {
    const arena = init.arena;
    const alloc = arena.allocator();
    const io = init.io;

    const argv = try init.minimal.args.toSlice(alloc);
    // node's `process.argv.slice(2)`; here argv[0] is this executable.
    const user_args = if (argv.len > 0) argv[1..] else argv[0..0];

    const parsed = switch (try md_fix_tables.parseArgs(alloc, user_args)) {
        .ok => |ok| ok,
        .err => |message| reportError(io, message),
    };

    if (parsed.file_path) |file_path| {
        if (file_path.len > 0) {
            // File mode: rewrite in place and print nothing.
            const raw = md_fix_tables.readInputFile(io, alloc, file_path) catch |err| {
                reportError(io, ioErrorMessage(alloc, io, file_path, err, .reading));
            };
            const content = try md_fix_tables.decodeUtf8(alloc, raw);
            const fixed = try md_fix_tables.fixTables(alloc, content, parsed.max_col);
            Io.Dir.cwd().writeFile(io, .{ .sub_path = file_path, .data = fixed }) catch |err| {
                reportError(io, ioErrorMessage(alloc, io, file_path, err, .writing));
            };
            return;
        }
    }

    // Stdin mode: read stdin and write the aligned result to stdout.
    const raw = md_fix_tables.readAllStdin(io, alloc) catch |err| {
        reportError(io, ioErrorMessage(alloc, io, "<stdin>", err, .reading));
    };
    const content = try md_fix_tables.decodeUtf8(alloc, raw);
    const fixed = try md_fix_tables.fixTables(alloc, content, parsed.max_col);

    var stdout_buffer: [16 * 1024]u8 = undefined;
    var stdout_file_writer: Io.File.Writer = .init(.stdout(), io, &stdout_buffer);
    const stdout = &stdout_file_writer.interface;
    try stdout.writeAll(fixed);
    try stdout.flush();
}

/// `reportError` in the JS: `Error: <message>\n` on stderr, exit code 1.
fn reportError(io: Io, message: []const u8) noreturn {
    var stderr_buffer: [1024]u8 = undefined;
    var stderr_file_writer: Io.File.Writer = .init(.stderr(), io, &stderr_buffer);
    const stderr = &stderr_file_writer.interface;
    stderr.print("Error: {s}\n", .{message}) catch {};
    stderr.flush() catch {};
    std.process.exit(1);
}

const IoStage = enum { reading, writing };

/// The message Node puts in `err.message` for a failed `readFileSync` /
/// `writeFileSync`, so stderr matches the JS tool byte for byte in the cases
/// a user can actually hit.
fn ioErrorMessage(alloc: std.mem.Allocator, io: Io, path: []const u8, err: anyerror, stage: IoStage) []const u8 {
    const abs = absolutePath(alloc, io, path);
    return switch (err) {
        error.FileNotFound => fmt(alloc, "ENOENT: no such file or directory, open '{s}'", .{abs}),
        error.IsDir => switch (stage) {
            // Node opens the directory fine and fails at the read, so no path.
            .reading => "EISDIR: illegal operation on a directory, read",
            .writing => fmt(alloc, "EISDIR: illegal operation on a directory, open '{s}'", .{abs}),
        },
        error.AccessDenied, error.PermissionDenied => fmt(alloc, "EACCES: permission denied, open '{s}'", .{abs}),
        error.NotDir => fmt(alloc, "ENOTDIR: not a directory, open '{s}'", .{abs}),
        else => fmt(alloc, "EIO: i/o error, open '{s}'", .{abs}),
    };
}

fn fmt(alloc: std.mem.Allocator, comptime f: []const u8, args: anytype) []const u8 {
    return std.fmt.allocPrint(alloc, f, args) catch "EIO: i/o error";
}

/// Node resolves the path against the cwd for its error messages
/// (`path.resolve` + `toNamespacedPath`); `std.fs.path.resolve` canonicalizes
/// to backslashes on Windows, just like `path.win32.resolve`.
fn absolutePath(alloc: std.mem.Allocator, io: Io, path: []const u8) []const u8 {
    const cwd = std.process.currentPathAlloc(io, alloc) catch return path;
    return std.fs.path.resolve(alloc, &.{ cwd, path }) catch return path;
}

test "ioErrorMessage formats Node-style messages" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const missing = ioErrorMessage(alloc, std.testing.io, "no-such-file.md", error.FileNotFound, .reading);
    try std.testing.expect(std.mem.startsWith(u8, missing, "ENOENT: no such file or directory, open '"));
    try std.testing.expect(std.mem.endsWith(u8, missing, "no-such-file.md'"));
    try std.testing.expect(std.mem.indexOf(u8, missing, ":\\") != null); // resolved to absolute

    try std.testing.expectEqualStrings(
        "EISDIR: illegal operation on a directory, read",
        ioErrorMessage(alloc, std.testing.io, "fixtures", error.IsDir, .reading),
    );
}
