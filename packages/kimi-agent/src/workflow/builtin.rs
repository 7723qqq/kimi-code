//! Built-in workflow catalog (data-driven) + native executors.
//!
//! Replaces the TS built-in JS scripts (`packages/agent-core-v2/src/app/workflow/builtin/*.js`).
//! Each workflow is a [`WorkflowSpec`]: metadata (name / description /
//! `whenToUse` / phases) plus an executor kind. `DeepResearch` runs a real
//! multi-phase research pipeline (planning agent → parallel web search →
//! source fetch → cross-check agent → report agent). The remaining eight run
//! a single orchestrator subagent driven by a workflow-specific prompt, using
//! the subagent's native tools (Read/Glob/Grep/Bash/WebSearch/FetchUrl).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use crate::agent::subagent::{generate_agent_id, run_child_agent_persistent_with_model};
use crate::tools::fetch_url::fetch_url;
use crate::tools::web_search::{WebSearchResultEntry, web_search};

use super::types::WorkflowRunEntry;

/// How a workflow drives subagents / tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExecutorKind {
    /// Full multi-phase research pipeline.
    DeepResearch,
    /// Single orchestrator subagent with a workflow-specific prompt.
    Orchestrator,
}

/// A built-in workflow definition.
pub(crate) struct WorkflowSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub when_to_use: &'static str,
    pub phases: &'static [&'static str],
    pub kind: ExecutorKind,
    /// Orchestrator prompt (used when `kind == Orchestrator`).
    pub orchestrator_prompt: &'static str,
}

/// All built-in workflows (mirrors the TS `BUILTIN_SCRIPTS` list).
pub(crate) const BUILTINS: &[WorkflowSpec] = &[
    WorkflowSpec {
        name: "deep-research",
        description: "Deep research orchestrator — plans search lines, executes parallel web searches, reads sources, cross-checks facts, and produces a structured report with citations.",
        when_to_use: "Use when the user wants a comprehensive, well-sourced answer to a research question that requires multiple web sources.",
        phases: &["Plan", "Search", "Read", "Group", "Crosscheck", "Report"],
        kind: ExecutorKind::DeepResearch,
        orchestrator_prompt: "",
    },
    WorkflowSpec {
        name: "code-review",
        description: "Code review — inspects the diff or target files, identifies bugs, security issues, style problems, and improvement opportunities, and produces a structured review with severity ratings.",
        when_to_use: "Use when the user wants a thorough review of code changes or a file before merging.",
        phases: &["Gather", "Analyze", "Report"],
        kind: ExecutorKind::Orchestrator,
        orchestrator_prompt: "You are running the code-review workflow. Inspect the code the user points at (a diff via `git diff`, specific files, or a directory). For each finding report: severity (critical/high/medium/low/nit), file and approximate location, a clear description of the problem, why it matters, and a concrete suggested fix. Cover correctness bugs, security issues, error handling, performance, and code style. End with a short summary of the overall code quality and the highest-priority fixes.",
    },
    WorkflowSpec {
        name: "test-generator",
        description: "Test generator — reads the target source file and produces a comprehensive test suite covering the main behaviors and edge cases.",
        when_to_use: "Use when the user wants tests written for a file or module that currently lacks coverage.",
        phases: &["Analyze", "Generate", "Validate"],
        kind: ExecutorKind::Orchestrator,
        orchestrator_prompt: "You are running the test-generator workflow. Read the target source file(s) the user names, identify the public API and the main behaviors and edge cases worth testing, then write a complete test suite. Match the project's existing test framework and conventions (inspect adjacent test files). Cover happy paths, edge cases, and error paths. Report the tests you wrote (or where you put them) and any assumptions you made.",
    },
    WorkflowSpec {
        name: "refactor-planner",
        description: "Refactoring impact analysis and step-by-step migration planner — analyzes code structure, identifies improvement opportunities, assesses risk, and generates a phased refactoring plan with rollback steps.",
        when_to_use: "Use when the user wants to refactor a codebase, improve code structure, reduce technical debt, or prepare for a larger migration.",
        phases: &["Analyze", "Identify", "Assess", "Plan"],
        kind: ExecutorKind::Orchestrator,
        orchestrator_prompt: "You are running the refactor-planner workflow. Analyze the code structure the user names, identify concrete improvement opportunities (extract methods/modules, rename, simplify, decouple, remove dead code), assess the risk and effort of each, and produce a phased refactoring plan. Each phase must list concrete steps, how to verify it worked, and how to roll back. End with an estimated total effort and any dependencies between phases.",
    },
    WorkflowSpec {
        name: "bug-triage",
        description: "Bug triage — analyzes a bug report or failing test, locates the likely root cause in the codebase, assesses impact and priority, and proposes a fix plan.",
        when_to_use: "Use when the user reports a bug or a failing test and wants help locating the root cause and planning the fix.",
        phases: &["Reproduce", "Locate", "Assess", "Plan"],
        kind: ExecutorKind::Orchestrator,
        orchestrator_prompt: "You are running the bug-triage workflow. Start from the bug report or failing test the user provides. Reproduce or understand the failure, trace the likely root cause through the relevant source, assess the impact and priority (what breaks, who is affected, how urgent), and propose a concrete fix plan with verification steps and any risks. Be precise about file paths and line numbers for the suspected root cause.",
    },
    WorkflowSpec {
        name: "pr-description",
        description: "PR description generator — reads the diff and generates a clear, conventional-commits-style pull request description with summary, changes, and testing notes.",
        when_to_use: "Use when the user wants a pull request description written for a branch or a diff.",
        phases: &["Analyze", "Describe"],
        kind: ExecutorKind::Orchestrator,
        orchestrator_prompt: "You are running the pr-description workflow. Gather the changes (e.g. `git diff main...HEAD` or the files the user names), summarize what the PR does, list the notable changes grouped logically, describe how it was tested (or what tests are needed), and note any follow-up work or breaking changes. Write the description to be copy-paste ready.",
    },
    WorkflowSpec {
        name: "architecture-review",
        description: "Architecture review and dependency analysis — scans module structure, detects circular dependencies, measures coupling/cohesion, identifies layer violations, and generates architecture documentation.",
        when_to_use: "Use when evaluating system architecture, detecting design decay, planning modularization, or onboarding new team members to the codebase.",
        phases: &["Scan", "Dependency", "Analyze", "Document"],
        kind: ExecutorKind::Orchestrator,
        orchestrator_prompt: "You are running the architecture-review workflow. Scan the module structure the user points at, map the modules and their responsibilities, detect circular dependencies and hub modules (high fan-in/fan-out), identify layer violations, and rate the architecture (good/fair/needs-work/poor). Produce a concise architecture document: overview, layers, data flow, strengths, weaknesses, and concrete recommendations.",
    },
    WorkflowSpec {
        name: "security-audit",
        description: "Security vulnerability audit — scans source files for OWASP Top 10 categories, hardcoded secrets, injection points, auth flaws, and dependency risks, producing a prioritized remediation plan.",
        when_to_use: "Use when auditing code for security vulnerabilities, before deploying to production, or when onboarding a security review process.",
        phases: &["Identify", "Inspect", "Analyze", "Report"],
        kind: ExecutorKind::Orchestrator,
        orchestrator_prompt: "You are running the security-audit workflow. Inspect the code the user names for security issues across the OWASP Top 10: injection, broken access control, cryptographic failures, hardcoded secrets/credentials, auth flaws, SSRF, insecure configuration, vulnerable dependencies, and logging/monitoring gaps. For each finding report the category, severity, file and location, the vulnerability, and a concrete remediation. End with a prioritized remediation plan. Never print actual secret values — only their location.",
    },
    WorkflowSpec {
        name: "migration-planner",
        description: "Migration planner — analyzes the current and target stack, inventories affected modules, and generates a phased migration plan with rollback and verification steps.",
        when_to_use: "Use when planning a technology or dependency migration, upgrading a framework, or moving between architectures.",
        phases: &["Inventory", "Analyze", "Plan"],
        kind: ExecutorKind::Orchestrator,
        orchestrator_prompt: "You are running the migration-planner workflow. The user names the current stack and the target stack (or the migration intent). Inventory the modules and usages that depend on the pieces being replaced, analyze the compatibility gaps and breaking changes, and produce a phased migration plan. Each phase must include concrete steps, verification, and rollback. Flag risks (data migration, API changes, third-party support) and estimate the total effort.",
    },
];

/// Caps for the deep-research pipeline.
const MAX_QUERIES: usize = 8;
const MAX_SOURCES: usize = 12;
const MAX_SOURCE_CHARS: usize = 5000;

/// Parameters the workflow executor needs to spawn native subagents.
pub(crate) struct ExecutorParams {
    pub host: Arc<dyn crate::callbacks::HostCallbacks>,
    pub homedir: Option<String>,
    pub native_llm: Option<crate::rpc::types::NativeLlmConfig>,
    pub permission: crate::permission::gate::PermissionGate,
    pub system_prompt: String,
    pub max_steps: u32,
    /// Parent agent's subagent depth; children run at `depth + 1`.
    pub depth: u32,
    pub hooks: Option<Arc<crate::hooks::external::HookManager>>,
    pub record_store: Option<std::sync::Arc<crate::persistence::RecordStore>>,
}

/// Spawn one native subagent for the workflow and record it against the run.
async fn run_child(
    params: &ExecutorParams,
    prompt: &str,
    entry: &Arc<Mutex<WorkflowRunEntry>>,
) -> Result<String, String> {
    let agent_id = generate_agent_id();
    let text = run_child_agent_persistent_with_model(
        params.host.clone(),
        params.homedir.clone(),
        params.native_llm.clone(),
        params.permission.clone(),
        &params.system_prompt,
        params.max_steps,
        params.depth + 1,
        "coder",
        prompt,
        params.hooks.clone(),
        &agent_id,
        None,
        None,
        params.record_store.clone(),
    )
    .await
    .map(|(_, text)| text)?;
    if let Ok(mut e) = entry.lock() {
        e.agent_count += 1;
    }
    Ok(text)
}

fn set_phase(entry: &Arc<Mutex<WorkflowRunEntry>>, phase: &str) {
    if let Ok(mut e) = entry.lock() {
        e.current_phase = Some(phase.to_string());
    }
}

fn is_cancelled(entry: &Arc<Mutex<WorkflowRunEntry>>) -> bool {
    entry.lock().map(|e| e.is_cancelled()).unwrap_or(false)
}

/// Truncate a source body to a bounded number of characters.
fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let head: String = text.chars().take(max_chars).collect();
        format!("{head}\n… [truncated]")
    }
}

/// Full multi-phase deep research pipeline (mirrors `builtin/deep-research.js`):
/// Plan → Search → Read → Crosscheck → Report.
async fn deep_research(
    params: ExecutorParams,
    args: &str,
    entry: &Arc<Mutex<WorkflowRunEntry>>,
) -> Result<String, String> {
    // Phase 1: Plan — a subagent turns the request into search queries.
    set_phase(entry, "Plan");
    let plan_prompt = format!(
        "You are the planning agent of a deep research workflow.\nResearch request: {args}\n\n\
         Break the question into distinct, web-searchable search queries. Output ONLY a numbered \
         list, one query per line, with no other text. Each query must be a concise phrase of 5-15 \
         words. Produce 4 to 8 queries."
    );
    let plan_text = run_child(&params, &plan_prompt, entry).await?;
    let mut queries: Vec<String> = plan_text
        .lines()
        .filter_map(|l| {
            let t = l.trim().trim_start_matches(|c: char| {
                c.is_ascii_digit() || matches!(c, '.' | ')' | ']' | '-' | '·' | ' ' | '\t')
            });
            let t = t.trim();
            if t.is_empty() || t.chars().count() < 4 {
                None
            } else {
                Some(t.to_string())
            }
        })
        .collect();
    if queries.is_empty() {
        return Err("The planning phase produced no search queries.".into());
    }
    queries.truncate(MAX_QUERIES);

    // Phase 2: Search — parallel web searches per query, deduped by URL.
    set_phase(entry, "Search");
    let mut search_results: Vec<WebSearchResultEntry> = Vec::new();
    for q in &queries {
        if is_cancelled(entry) {
            return Err("cancelled".into());
        }
        match web_search(q).await {
            Ok(rs) => search_results.extend(rs),
            Err(e) => search_results.push(WebSearchResultEntry {
                title: format!("(search failed: {e})"),
                url: String::new(),
                snippet: String::new(),
                site_name: None,
            }),
        }
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut top: Vec<WebSearchResultEntry> = Vec::new();
    for r in search_results {
        if r.url.is_empty() {
            continue;
        }
        if seen.insert(r.url.clone()) {
            top.push(r);
            if top.len() >= MAX_SOURCES {
                break;
            }
        }
    }
    if top.is_empty() {
        return Err("No web search results were found.".into());
    }

    // Phase 3: Read — fetch the top sources.
    set_phase(entry, "Read");
    let mut sources: Vec<String> = Vec::new();
    for r in &top {
        if is_cancelled(entry) {
            return Err("cancelled".into());
        }
        match fetch_url(&r.url).await {
            Ok(f) => {
                sources.push(format!("## {}\nURL: {}\n{}\n", r.title, r.url, truncate(&f.content, MAX_SOURCE_CHARS)));
            }
            Err(e) => {
                sources.push(format!("## {}\nURL: {}\n(fetch failed: {e})\n", r.title, r.url));
            }
        }
    }
    let sources_block = sources.join("\n");

    // Phase 4: Crosscheck — a subagent checks facts and finds gaps.
    set_phase(entry, "Crosscheck");
    let crosscheck_prompt = format!(
        "You are the cross-checking agent of a deep research workflow.\nResearch request: {args}\n\n\
         Collected sources:\n\n{src}\n\n\
         Cross-check the facts across the sources. Identify contradictions and gaps, and note which \
         claims are well-supported and which need more evidence. Be concise and factual.",
        src = sources_block,
    );
    let crosscheck = run_child(&params, &crosscheck_prompt, entry).await?;

    // Phase 5: Report — a subagent writes the final report.
    set_phase(entry, "Report");
    let report_prompt = format!(
        "You are the reporting agent of a deep research workflow. Write the final research report.\n\
         Research request: {args}\n\nSOURCES:\n{src}\n\nCROSS-CHECK:\n{crosscheck}\n\n\
         Produce a well-structured final report: an executive summary, key findings with source URLs \
         cited inline, and a limitations note. Do not invent facts outside the sources.",
        src = sources_block,
        crosscheck = crosscheck,
    );
    let report = run_child(&params, &report_prompt, entry).await?;
    Ok(report)
}

/// Generic single-orchestrator executor for the other eight workflows.
async fn orchestrator(
    params: ExecutorParams,
    spec: &WorkflowSpec,
    args: &str,
    entry: &Arc<Mutex<WorkflowRunEntry>>,
) -> Result<String, String> {
    if let Some(first) = spec.phases.first() {
        set_phase(entry, first);
    } else {
        set_phase(entry, "Execute");
    }
    let prompt = format!(
        "{}\n\nWorkflow phases: {}\n\nUser request: {}\n\nExecute this workflow now. Use your \
         available tools (Read, Glob, Grep, Bash, WebSearch, FetchUrl) as needed. When finished, \
         report the complete result.",
        spec.orchestrator_prompt,
        spec.phases.join(" → "),
        if args.trim().is_empty() { "(none provided)" } else { args },
    );
    run_child(&params, &prompt, entry).await
}

/// Execute a built-in workflow, returning its final result text.
pub(crate) async fn execute_workflow(
    params: ExecutorParams,
    spec: &WorkflowSpec,
    args: &str,
    entry: &Arc<Mutex<WorkflowRunEntry>>,
) -> Result<String, String> {
    match spec.kind {
        ExecutorKind::DeepResearch => deep_research(params, args, entry).await,
        ExecutorKind::Orchestrator => orchestrator(params, spec, args, entry).await,
    }
}
