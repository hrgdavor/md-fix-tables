const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // The library module: everything `md-fix-tables.js` exports, importable as
    // `@import("md_fix_tables")` (also by consumers of this package).
    const mod = b.addModule("md_fix_tables", .{
        .root_source_file = b.path("src/root.zig"),
        // A target is required because the module is also tested directly.
        .target = target,
    });

    // The CLI executable.
    const exe = b.addExecutable(.{
        .name = "md-fix-tables",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "md_fix_tables", .module = mod },
            },
        }),
    });
    // `.dest_dir = .{ .override = .prefix }` installs the binary directly into
    // zig-out/ instead of zig-out/bin/. The release workflow's packaging paths
    // must stay in step with this (see .github/workflows/release.yml).
    const install_exe = b.addInstallArtifact(exe, .{
        .dest_dir = .{ .override = .prefix },
    });
    b.getInstallStep().dependOn(&install_exe.step);

    const run_step = b.step("run", "Run the aligner");
    const run_cmd = b.addRunArtifact(exe);
    run_step.dependOn(&run_cmd.step);
    // Run from the install directory rather than the cache.
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);

    const mod_tests = b.addTest(.{ .root_module = mod });
    const run_mod_tests = b.addRunArtifact(mod_tests);

    const exe_tests = b.addTest(.{ .root_module = exe.root_module });
    const run_exe_tests = b.addRunArtifact(exe_tests);

    const test_step = b.step("test", "Run tests");
    test_step.dependOn(&run_mod_tests.step);
    test_step.dependOn(&run_exe_tests.step);
}
