const check = @import("check.zig");

const gate_wiring = @import("checks/gate_wiring.zig");
const ci_coverage = @import("checks/ci_coverage.zig");
const stale_artifacts = @import("checks/stale_artifacts.zig");
const upstream_drift = @import("checks/upstream_drift.zig");
const orphan_exports = @import("checks/orphan_exports.zig");
const silent_catch = @import("checks/silent_catch.zig");
const dangling_refs = @import("checks/dangling_refs.zig");
const workflow_triggers = @import("checks/workflow_triggers.zig");
const scripts_wiring = @import("checks/scripts_wiring.zig");

/// Every check the tool knows about, in report order.
pub const all = [_]check.Check{
    .{
        .name = "gate-wiring",
        .description = "Documented gates that nothing actually invokes",
        .severity = .err,
        .run = gate_wiring.run,
    },
    .{
        .name = "ci-coverage",
        .description = "Workspace members whose tests or typecheck never run",
        .severity = .err,
        .run = ci_coverage.run,
    },
    .{
        .name = "stale-artifacts",
        .description = "Generated files that drifted from their source",
        .severity = .err,
        .run = stale_artifacts.run,
    },
    .{
        .name = "upstream-drift",
        .description = "Files upstream carries that this branch dropped",
        .severity = .warn,
        .run = upstream_drift.run,
    },
    .{
        .name = "orphan-exports",
        .description = "Exported functions production code never calls",
        .severity = .err,
        .run = orphan_exports.run,
    },
    .{
        .name = "silent-catch",
        .description = "Empty catch blocks that swallow errors",
        .severity = .err,
        .run = silent_catch.run,
    },
    .{
        .name = "workflow-triggers",
        .description = "Documented CI jobs that no pull request runs",
        .severity = .err,
        .run = workflow_triggers.run,
    },
    .{
        .name = "dangling-refs",
        .description = "Tool names a list mentions but nothing registers",
        .severity = .err,
        .run = dangling_refs.run,
    },
    .{
        .name = "scripts-wiring",
        .description = "Package scripts nothing invokes",
        .severity = .warn,
        .run = scripts_wiring.run,
    },
};
