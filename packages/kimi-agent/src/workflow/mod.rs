/// Workflow module — native `Workflow` tool + data-driven built-in workflows.
///
/// Replaces the TS Workflow system
/// (`packages/agent-core-v2/src/app/workflow/`), which ran user JS scripts
/// in a `vm` sandbox. The native engine is data-driven: built-in workflows
/// are declared as [`builtin::WorkflowSpec`]s and executed by native
/// subagents, with a run registry so `status` / `wait` / `cancel` observe
/// background runs across turns.

pub(crate) mod builtin;
pub(crate) mod tool;
pub(crate) mod types;
