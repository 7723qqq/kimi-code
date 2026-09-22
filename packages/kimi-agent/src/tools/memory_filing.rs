//! Background memory filing pass.
//!
//! The memory section of the system prompt promises that durable filing
//! happens automatically after each turn, so the model never files on its own
//! initiative. This module is that promise: a spawned task re-reads the
//! finished exchange, asks the secondary model what is durable, and applies
//! the answer through [`crate::tools::memory_store`].
//!
//! Four rules shape the pass:
//!
//! - **Additive only.** It appends lines to an existing file or creates a new
//!   one; it never overwrites and never deletes. A "forget" is a boundary the
//!   pass cannot cross, and a turn that already wrote or deleted memory is
//!   skipped entirely, so the model's own change is the one that stands.
//! - **Secondary model only.** The pass costs one LLM call per turn; with no
//!   `[secondary_model]` configured it does not run at all rather than spend
//!   the session model's budget.
//! - **Best-effort.** Memory is not load-bearing: a failed call, unparseable
//!   output or rejected write is logged and dropped, never surfaced to the
//!   user and never allowed to fail a turn.
//! - **Off by default.** The pass runs only when the gate is on *and* the
//!   memory section is in the system prompt, so a session that never saw the
//!   memory tools never files anything.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use crate::tools::memory_paths::{MemoryType, parse_memory_path};
use crate::tools::memory_store;
use crate::turn_loop::types::{LLM, LLMChatParams, LLMMessage, ToolCall};

/// The env switch, following the crate's `KIMI_AGENT_TRACE` idiom.
pub const FILING_ENV: &str = "KIMI_AGENT_MEMORY_FILING";

/// The `[experimental]` key that enables the pass.
pub const FILING_CONFIG_KEY: &str = "memory_filing";

/// Most files one pass may touch. A pass that wants more than this is
/// misreading the exchange, and the cap bounds the blast radius of one bad
/// call.
const MAX_ENTRIES: usize = 8;

/// Longest tool-activity line the prompt carries.
const TOOL_LINE_MAX_CHARS: usize = 160;

/// Most aliases one created file may carry (the memory section's own cap).
const MAX_ALIASES: usize = 8;

/// Wall-clock bound on one pass. The task is spawned and never awaited, so
/// without this a provider that never answers would leak it for the life of
/// the process.
const FILING_TIMEOUT: Duration = Duration::from_secs(120);

/// Parse a switch value: `1`/`true`/`on`/`yes` and their negatives, anything
/// else unrecognized.
pub fn parse_switch(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "on" | "yes" => Some(true),
        "0" | "false" | "off" | "no" => Some(false),
        _ => None,
    }
}

/// The env override, `None` when unset or unrecognized.
pub fn env_switch() -> Option<bool> {
    std::env::var(FILING_ENV)
        .ok()
        .and_then(|value| parse_switch(&value))
}

/// The `[experimental].memory_filing` entry: `true`, or any string but
/// `false`/empty, enables the pass. `None` when the entry is unset, so the
/// caller can tell "not configured" from an explicit `false`.
pub fn config_flag(config: &crate::config::KimiConfig) -> Option<bool> {
    match config.experimental.get(FILING_CONFIG_KEY) {
        Some(crate::config::ExperimentalValue::Bool(value)) => Some(*value),
        Some(crate::config::ExperimentalValue::String(value)) => {
            Some(!value.is_empty() && value != "false")
        }
        None => None,
    }
}

/// Resolve the gate: the env override wins over the config entry. The pass
/// runs whenever the memory section is in the prompt, so an unset value on
/// both sides leaves it on — the section promises automatic filing, and a
/// silent opt-out would make the prompt lie. Set either switch to `false` to
/// stop spending the per-turn LLM call.
pub fn resolve_gate(env: Option<bool>, config: Option<bool>) -> bool {
    env.or(config).unwrap_or(true)
}

/// The model the pass should run on, or `None` when it must not run at all.
///
/// Every condition is a reason to stand down: the gate is off, the memory
/// section never reached the prompt, no secondary model is configured, or the
/// turn already wrote or deleted memory itself.
pub fn filing_model(
    gate: bool,
    memory_in_prompt: bool,
    secondary_llm: Option<&Arc<dyn LLM>>,
    turn_wrote_memory: bool,
) -> Option<&Arc<dyn LLM>> {
    if !gate || !memory_in_prompt || turn_wrote_memory {
        return None;
    }
    secondary_llm
}

/// The memory tools that mutate the store, in both the snake spelling the
/// memory section documents and the squashed alias the tool table accepts.
const MEMORY_MUTATION_TOOLS: [&str; 8] = [
    "memory_write",
    "memorywrite",
    "memory_str_replace",
    "memorystrreplace",
    "memory_append",
    "memoryappend",
    "memory_delete",
    "memorydelete",
];

/// Whether the turn performed a memory mutation itself. Such a turn owns its
/// memory change — the pass leaves it alone so the model's write stands.
pub fn turn_wrote_memory(messages: &[LLMMessage]) -> bool {
    messages.iter().any(|message| {
        message
            .tool_calls
            .iter()
            .any(|call| MEMORY_MUTATION_TOOLS.contains(&call.name.to_ascii_lowercase().as_str()))
    })
}

/// One line per tool call the turn made, for the prompt's `<tool_activity>`
/// block: the name plus the argument that names the target. Results are left
/// out — they are the fetched content the pass must not file.
pub fn tool_activity(messages: &[LLMMessage]) -> Vec<String> {
    messages
        .iter()
        .flat_map(|message| message.tool_calls.iter())
        .map(render_tool_call)
        .collect()
}

fn render_tool_call(call: &ToolCall) -> String {
    let target = [
        "path",
        "file_path",
        "command",
        "pattern",
        "query",
        "url",
        "prompt",
    ]
    .iter()
    .find_map(|key| call.arguments.get(*key).and_then(|value| value.as_str()))
    .map(|value| truncate_chars(value, TOOL_LINE_MAX_CHARS));
    match target {
        Some(target) => format!("{}({target})", call.name),
        None => call.name.clone(),
    }
}

/// One finished exchange, as the pass sees it.
pub struct Exchange {
    pub user_message: String,
    pub assistant_reply: String,
    pub tool_activity: Vec<String>,
}

/// A ready-to-run filing pass: the model to ask, the store to write to, and
/// the exchange to read.
pub struct FilingPass {
    pub llm: Arc<dyn LLM>,
    pub base: PathBuf,
    pub project_id: String,
    pub exchange: Exchange,
}

impl FilingPass {
    /// Run the pass and report how many files it touched. Every failure is
    /// logged and swallowed: memory is best-effort, so nothing here may reach
    /// the user or fail a turn.
    pub async fn run(self) -> usize {
        let listing = memory_store::render_listing(&memory_store::list_entries_for(
            &self.base,
            &self.project_id,
            "",
        ));
        let prompt = filing_prompt(
            &self.project_id,
            &listing,
            &memory_store::render_profile(&self.base),
            &memory_store::render_preferences(&self.base),
            &self.exchange,
        );
        let messages: Arc<[LLMMessage]> = Arc::from(vec![
            LLMMessage::system(FILING_SYSTEM_PROMPT),
            LLMMessage::user(prompt),
        ]);
        let call = self.llm.chat(LLMChatParams {
            messages,
            tools: Arc::from(Vec::new()),
            cancel: None,
        });
        let response = match tokio::time::timeout(FILING_TIMEOUT, call).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                tracing::debug!(error = %error, "memory filing pass: model call failed");
                return 0;
            }
            Err(_) => {
                tracing::debug!("memory filing pass: model call timed out");
                return 0;
            }
        };
        let Some(entries) = parse_filing_output(&response.content) else {
            tracing::debug!("memory filing pass: unparseable model output");
            return 0;
        };
        apply_entries(&self.base, &entries)
    }

    /// Spawn the pass on the runtime and return immediately, so the turn
    /// report and the user-visible reply are never delayed by it.
    pub fn spawn(self) {
        tokio::spawn(self.run());
    }
}

/// One memory the model wants to file.
#[derive(Debug, Deserialize)]
struct FilingEntry {
    path: String,
    #[serde(default)]
    description: String,
    #[serde(default, rename = "type")]
    memory_type: Option<String>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    lines: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct FilingOutput {
    #[serde(default)]
    memories: Vec<FilingEntry>,
}

/// Parse the model's answer. The model is asked for bare JSON, but a fenced
/// block is common enough that the outermost braces are extracted first.
fn parse_filing_output(content: &str) -> Option<Vec<FilingEntry>> {
    let start = content.find('{')?;
    let end = content.rfind('}')?;
    if end <= start {
        return None;
    }
    let output: FilingOutput = serde_json::from_str(&content[start..=end]).ok()?;
    Some(output.memories)
}

/// Apply the parsed entries through the store, reporting how many files were
/// touched. Each entry is independent: one rejected write never stops the
/// others.
fn apply_entries(base: &Path, entries: &[FilingEntry]) -> usize {
    let mut touched = 0;
    for entry in entries.iter().take(MAX_ENTRIES) {
        match apply_entry(base, entry) {
            Ok(()) => touched += 1,
            Err(error) => {
                tracing::debug!(path = %entry.path, error = %error, "memory filing pass: entry skipped");
            }
        }
    }
    touched
}

fn apply_entry(base: &Path, entry: &FilingEntry) -> Result<(), String> {
    let path = entry.path.trim();
    if path.is_empty() {
        return Err("the entry names no path".into());
    }
    let lines = render_lines(&entry.lines);
    if lines.is_empty() {
        return Err("the entry carries no lines".into());
    }
    match memory_store::read(base, path) {
        // The file exists: add the lines and keep everything already in it.
        Ok((content, version)) => {
            let fresh = without_existing(&content, &lines);
            if fresh.is_empty() {
                return Err("every line is already filed".into());
            }
            memory_store::append(base, path, &fresh, &version).map(|_| ())
        }
        // A new file: the pass renders the frontmatter itself, because the
        // store's write path stores whatever it is handed.
        Err(_) => {
            let content = render_file(path, entry, &lines)?;
            memory_store::write(base, path, &content, "new").map(|_| ())
        }
    }
}

/// Drop the lines the file already carries. The pass sees the listing, not
/// the file bodies, so this is the only guard against the same fact landing
/// twice when it comes up again in a later turn.
fn without_existing(content: &str, lines: &str) -> String {
    let existing: Vec<&str> = content.lines().map(str::trim).collect();
    lines
        .lines()
        .filter(|line| !existing.contains(&line.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Render the entry's facts as `[stated]` content lines. The tag is the only
/// one the pass writes, so it is added here rather than trusted from the
/// model — and a line the model tagged `[observed]` or `[inferred]` is
/// dropped, because those are not the pass's to write.
fn render_lines(lines: &[String]) -> String {
    lines
        .iter()
        .filter_map(|line| render_line(line))
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_line(line: &str) -> Option<String> {
    let text = line.trim();
    let text = text.strip_prefix("- ").unwrap_or(text).trim();
    if ["[observed]", "[inferred]"]
        .iter()
        .any(|tag| text.starts_with(tag))
    {
        return None;
    }
    let text = text.strip_prefix("[stated]").unwrap_or(text).trim();
    (!text.is_empty()).then(|| format!("- [stated] {text}"))
}

/// Render a new memory file: the memory section's frontmatter plus the
/// `[stated]` lines. `name` is the path stem, and `sources` is always `chat`
/// — the pass files what the user said in this conversation.
fn render_file(path: &str, entry: &FilingEntry, lines: &str) -> Result<String, String> {
    if parse_memory_path(path).is_none() {
        return Err(format!("`{path}` is not a memory path"));
    }
    let file_name = path.rsplit('/').next().unwrap_or(path);
    let stem = file_name.strip_suffix(".md").unwrap_or(file_name);
    let description = single_line(&entry.description).unwrap_or_else(|| {
        lines
            .lines()
            .next()
            .unwrap_or_default()
            .trim_start_matches("- [stated] ")
            .to_string()
    });
    let memory_type = entry
        .memory_type
        .as_deref()
        .and_then(MemoryType::parse_type)
        .unwrap_or(MemoryType::Note);
    let aliases: Vec<String> = entry
        .aliases
        .iter()
        .map(|alias| {
            alias
                .trim()
                .trim_matches(['[', ']', '"', '\''])
                .trim()
                .to_string()
        })
        .filter(|alias| !alias.is_empty() && !alias.contains(',') && !alias.contains('\n'))
        .take(MAX_ALIASES)
        .collect();
    Ok(format!(
        "---\nname: {stem}\ndescription: {description}\ntype: {}\nsources: [chat]\naliases: [{}]\n---\n\n{lines}\n",
        memory_type.as_str(),
        aliases.join(", ")
    ))
}

/// A frontmatter value must stay on one line, or it breaks the block it sits
/// in.
fn single_line(value: &str) -> Option<String> {
    let line = value.replace(['\n', '\r'], " ").trim().to_string();
    (!line.is_empty()).then_some(line)
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// The filing instructions. They restate the memory section's calibration
/// rules for a model that sees one exchange and no conversation: what counts
/// as durable, how to phrase it, and where it goes.
const FILING_SYSTEM_PROMPT: &str = "\
You file durable memories from one finished exchange between a user and an assistant.

You see the exchange, its tool activity, and the memory listing. Return the memories worth keeping as JSON. Most exchanges are worth nothing: an empty list is the normal answer.

File only what the user said. The test for every line: did the user say this? That excludes
- conclusions the assistant drew, and its advice, plans, recommendations, or option lists
- anything fetched or generated — search results, tool output, code the assistant wrote
- forward-looking state: what the assistant is about to do, or what the user will do next
- secondhand reports, and the assistant's own reasoning
- anything already filed, or implied by a line in the listing, <profile>, or <preferences>

Calibrate the claim to the evidence:
- one mention earns \"mentioned X once\", never \"X enthusiast\"
- never upgrade a single mention into a generalization
- a brief \"sounds good\" confirms the shape of what the assistant said, not every detail inside it
- details the assistant supplied that the user did not individually address are not the user's
- prefer durable phrasing over precise figures that go stale: \"meeting-heavy mornings\" outlasts \"10:00-10:15 team check-in\"

The horizon test: would the line still be true and worth reading a month from now, in a conversation about something else? Identity, people, preferences, and ongoing areas pass it. The moving state of a task that finishes within a conversation or two fails it — file the stable residue and let the moving state expire with the task.

Facts about the user's stable world — people and relationships, where they live and work, roles, ongoing projects — are durable on a single mention. Tastes and pastimes are not: a single passing mention is not filed; file those when they recur or when the user dwells on them.

A forget is a boundary: if the user asked to forget or remove something, never file it.

Where it goes — one file per subject, and a fact about subject X goes in X's file only:
- global/profile.md — who they are: name, role or title, where they work, what they work on at the level it stays stable, when they started. The test: would this line still be true in three months? Keep it under 300 words.
- global/preferences.md — how they want the assistant to behave: output format, level of detail, what to skip. Not for things they like — those are facts about them.
- global/topics/<domain>.md — habits, tastes, routines, time zone, recurring topics.
- projects/<project-id>/areas/<name>.md — any ongoing area of involvement: named projects, incidents, recurring responsibilities, chores in progress, unnamed work that keeps coming up. One file can hold multiple threads.
- global/people/<name>.md — anyone whose context helps future conversations. Relationship context, not a dossier; private or sensitive details about that person's own life do not go here. Slug the name or the relationship and put the other handle in aliases.

Before creating a file, check the listing for aliases: if what the user describes matches an existing file's aliases, write there. Link related subjects with [[name]] — a link to a name that does not exist yet is fine.

Answer with JSON only, no prose and no code fence:
{\"memories\": [{\"path\": \"...\", \"description\": \"...\", \"type\": \"note\", \"aliases\": [\"...\"], \"lines\": [\"...\"]}]}

- path: a memory path under global/ or projects/<project-id>/
- description: one line — what the file covers and when to read it. Used only when the file is created.
- type: note | decision | pattern | lesson | reference
- aliases: people and areas only, under 8, durable names — not branch names, PR numbers, or dates
- lines: the facts, one per line, phrased as the user stated them. Do not write the [stated] tag or a bullet — both are added for you.

Return {\"memories\": []} when nothing is durable.";

fn filing_prompt(
    project_id: &str,
    listing: &str,
    profile: &str,
    preferences: &str,
    exchange: &Exchange,
) -> String {
    let mut out = format!(
        "Project id: {project_id}\n\n{listing}\n\n{profile}\n\n{preferences}\n\n<exchange>\n"
    );
    out.push_str("<user>\n");
    out.push_str(&exchange.user_message);
    out.push_str("\n</user>\n\n<assistant>\n");
    out.push_str(&exchange.assistant_reply);
    out.push_str("\n</assistant>\n");
    if !exchange.tool_activity.is_empty() {
        out.push_str("\n<tool_activity>\n");
        for line in &exchange.tool_activity {
            out.push_str("- ");
            out.push_str(line);
            out.push('\n');
        }
        out.push_str("</tool_activity>\n");
    }
    out.push_str("</exchange>");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ExperimentalValue, KimiConfig};
    use crate::rpc::types::BoxFuture;
    use crate::turn_loop::types::LLMChatResponse;
    use std::sync::Mutex;
    use tempfile::TempDir;

    const PROFILE: &str = "---\nname: profile\ndescription: Who they are.\ntype: note\nsources: [chat]\naliases: []\n---\n\n- [stated] Works on the kimi-code CLI.\n";

    /// A scripted secondary model: one canned answer, and the prompts it was
    /// asked recorded for inspection.
    struct ScriptedLlm {
        answer: Result<String, String>,
        seen: Mutex<Vec<String>>,
    }

    impl ScriptedLlm {
        fn answering(answer: &str) -> Arc<Self> {
            Arc::new(Self {
                answer: Ok(answer.to_string()),
                seen: Mutex::new(Vec::new()),
            })
        }

        fn failing(message: &str) -> Arc<Self> {
            Arc::new(Self {
                answer: Err(message.to_string()),
                seen: Mutex::new(Vec::new()),
            })
        }

        fn prompts(&self) -> Vec<String> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl LLM for ScriptedLlm {
        fn system_prompt(&self) -> &str {
            "filing"
        }
        fn model_name(&self) -> &str {
            "secondary"
        }
        fn is_retryable_error(&self, _error: &str) -> bool {
            false
        }
        fn chat(
            &self,
            params: LLMChatParams,
        ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            self.seen
                .lock()
                .unwrap()
                .extend(params.messages.iter().map(|m| m.content.clone()));
            let answer = self.answer.clone();
            Box::pin(async move {
                match answer {
                    Ok(content) => Ok(LLMChatResponse {
                        content,
                        timing: None,
                        ..Default::default()
                    }),
                    Err(message) => Err(Box::new(std::io::Error::other(message))
                        as Box<dyn std::error::Error + Send + Sync>),
                }
            })
        }
    }

    fn base() -> (TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("memory");
        (dir, base)
    }

    fn exchange() -> Exchange {
        Exchange {
            user_message: "I moved to Berlin last month.".into(),
            assistant_reply: "Noted — anything you want me to keep in mind?".into(),
            tool_activity: vec!["Read(src/main.rs)".into()],
        }
    }

    fn pass(base: &Path, llm: Arc<ScriptedLlm>) -> FilingPass {
        FilingPass {
            llm,
            base: base.to_path_buf(),
            project_id: "28c0fe7f6661".into(),
            exchange: exchange(),
        }
    }

    fn call(name: &str) -> LLMMessage {
        LLMMessage {
            role: "assistant".into(),
            tool_calls: vec![ToolCall {
                id: "call-1".into(),
                name: name.into(),
                arguments: serde_json::json!({ "path": "global/profile.md" }),
                extras: None,
            }],
            ..Default::default()
        }
    }

    #[test]
    fn the_gate_is_on_unless_a_switch_says_otherwise() {
        assert!(resolve_gate(None, None), "unset follows the memory section");
        assert!(!resolve_gate(None, Some(false)));
        assert!(
            !resolve_gate(Some(false), Some(true)),
            "the env kill switch wins"
        );
        assert!(resolve_gate(Some(true), None));
        assert!(resolve_gate(None, Some(true)));
    }

    #[test]
    fn the_config_flag_reads_the_experimental_map() {
        let mut config = KimiConfig::default();
        assert_eq!(config_flag(&config), None, "unset is not a value");
        config
            .experimental
            .insert(FILING_CONFIG_KEY.into(), ExperimentalValue::Bool(false));
        assert_eq!(config_flag(&config), Some(false));
        config.experimental.insert(
            FILING_CONFIG_KEY.into(),
            ExperimentalValue::String("false".into()),
        );
        assert_eq!(config_flag(&config), Some(false));
        config.experimental.insert(
            FILING_CONFIG_KEY.into(),
            ExperimentalValue::String(String::new()),
        );
        assert_eq!(config_flag(&config), Some(false));
        config
            .experimental
            .insert(FILING_CONFIG_KEY.into(), ExperimentalValue::Bool(true));
        assert_eq!(config_flag(&config), Some(true));
        config.experimental.insert(
            FILING_CONFIG_KEY.into(),
            ExperimentalValue::String("true".into()),
        );
        assert_eq!(config_flag(&config), Some(true));
    }

    #[test]
    fn the_env_switch_parses_both_directions() {
        assert_eq!(parse_switch("1"), Some(true));
        assert_eq!(parse_switch(" TRUE "), Some(true));
        assert_eq!(parse_switch("on"), Some(true));
        assert_eq!(parse_switch("0"), Some(false));
        assert_eq!(parse_switch("False"), Some(false));
        assert_eq!(parse_switch("off"), Some(false));
        assert_eq!(parse_switch("maybe"), None);
        assert_eq!(parse_switch(""), None);
    }

    #[test]
    fn the_pass_needs_the_gate_the_prompt_a_model_and_a_clean_turn() {
        let model: Arc<dyn LLM> = ScriptedLlm::answering("{}");
        assert!(filing_model(true, true, Some(&model), false).is_some());
        assert!(
            filing_model(false, true, Some(&model), false).is_none(),
            "the gate is off"
        );
        assert!(
            filing_model(true, false, Some(&model), false).is_none(),
            "the memory section is not in the prompt"
        );
        assert!(
            filing_model(true, true, None, false).is_none(),
            "no secondary model is configured"
        );
        assert!(
            filing_model(true, true, Some(&model), true).is_none(),
            "the turn wrote memory itself"
        );
    }

    #[test]
    fn a_turn_that_mutated_memory_is_recognized() {
        for name in [
            "memory_write",
            "memory_str_replace",
            "memory_append",
            "memory_delete",
            "MemoryWrite",
            "memorywrite",
            "memorystrreplace",
        ] {
            assert!(turn_wrote_memory(&[call(name)]), "{name}");
        }
        for name in ["memory_read", "memory_list", "Read", "Write"] {
            assert!(!turn_wrote_memory(&[call(name)]), "{name}");
        }
        assert!(!turn_wrote_memory(&[LLMMessage::user("hello")]));
    }

    #[test]
    fn tool_activity_names_the_target_and_leaves_results_out() {
        let messages = vec![
            call("Read"),
            LLMMessage {
                role: "assistant".into(),
                tool_calls: vec![ToolCall {
                    id: "call-2".into(),
                    name: "Bash".into(),
                    arguments: serde_json::json!({ "command": "cargo test" }),
                    extras: None,
                }],
                ..Default::default()
            },
            LLMMessage::tool_result("call-2", "a very long tool result"),
            LLMMessage {
                role: "assistant".into(),
                tool_calls: vec![ToolCall {
                    id: "call-3".into(),
                    name: "TodoList".into(),
                    arguments: serde_json::json!({ "todos": [] }),
                    extras: None,
                }],
                ..Default::default()
            },
        ];
        assert_eq!(
            tool_activity(&messages),
            vec![
                "Read(global/profile.md)".to_string(),
                "Bash(cargo test)".to_string(),
                "TodoList".to_string(),
            ]
        );
    }

    #[test]
    fn the_prompt_carries_the_listing_the_exchange_and_the_calibration_rules() {
        let (_dir, base) = base();
        memory_store::write(&base, "global/profile.md", PROFILE, "new").unwrap();
        let listing = memory_store::render_listing(&memory_store::list_entries_for(
            &base,
            "28c0fe7f6661",
            "",
        ));
        let prompt = filing_prompt(
            "28c0fe7f6661",
            &listing,
            &memory_store::render_profile(&base),
            &memory_store::render_preferences(&base),
            &exchange(),
        );
        assert!(prompt.contains("Project id: 28c0fe7f6661"), "{prompt}");
        assert!(prompt.contains("<memory_listing>"), "{prompt}");
        assert!(prompt.contains("global/profile.md"), "{prompt}");
        assert!(prompt.contains("<profile>"), "{prompt}");
        assert!(prompt.contains("<preferences>"), "{prompt}");
        assert!(
            prompt.contains("<user>\nI moved to Berlin last month.\n</user>"),
            "{prompt}"
        );
        assert!(prompt.contains("<assistant>\nNoted"), "{prompt}");
        assert!(
            prompt.contains("<tool_activity>\n- Read(src/main.rs)\n</tool_activity>"),
            "{prompt}"
        );
        assert!(FILING_SYSTEM_PROMPT.contains("did the user say this"));
        assert!(FILING_SYSTEM_PROMPT.contains("A forget is a boundary"));
        assert!(FILING_SYSTEM_PROMPT.contains("horizon test"));
    }

    #[test]
    fn the_marker_identifies_the_memory_section_in_an_assembled_prompt() {
        assert!(
            crate::prompt::builder::MEMORY_SECTION
                .contains(crate::prompt::builder::MEMORY_SECTION_MARKER)
        );
    }

    #[tokio::test]
    async fn the_pass_appends_to_an_existing_file_and_creates_a_new_one() {
        let (_dir, base) = base();
        memory_store::write(&base, "global/profile.md", PROFILE, "new").unwrap();
        let llm = ScriptedLlm::answering(
            r#"{"memories":[
                {"path":"global/profile.md","lines":["Lives in Berlin."]},
                {"path":"global/people/sister.md","description":"The user's sister.","type":"note","aliases":["anna"],"lines":["Planning [[spain-trip]] together."]}
            ]}"#,
        );
        assert_eq!(pass(&base, llm.clone()).run().await, 2);

        let (profile, _) = memory_store::read(&base, "global/profile.md").unwrap();
        assert!(profile.contains("- [stated] Works on the kimi-code CLI."));
        assert!(
            profile.ends_with("- [stated] Lives in Berlin.\n"),
            "{profile}"
        );

        let (sister, _) = memory_store::read(&base, "global/people/sister.md").unwrap();
        assert_eq!(
            sister,
            "---\nname: sister\ndescription: The user's sister.\ntype: note\nsources: [chat]\naliases: [anna]\n---\n\n- [stated] Planning [[spain-trip]] together.\n"
        );

        // The prompt the model saw carried the listing and the exchange.
        let prompts = llm.prompts();
        assert_eq!(prompts.len(), 2, "one system message and one user message");
        assert!(prompts[0].contains("did the user say this"));
        assert!(prompts[1].contains("global/profile.md"));
        assert!(prompts[1].contains("I moved to Berlin last month."));
    }

    #[tokio::test]
    async fn the_pass_normalizes_the_lines_the_model_returns() {
        let (_dir, base) = base();
        let llm = ScriptedLlm::answering(
            r#"{"memories":[{"path":"global/topics/habits.md","lines":["- [stated] Runs in the morning.","", "  Reads at night.  "]}]}"#,
        );
        assert_eq!(pass(&base, llm).run().await, 1);
        let (content, _) = memory_store::read(&base, "global/topics/habits.md").unwrap();
        assert!(
            content.ends_with("- [stated] Runs in the morning.\n- [stated] Reads at night.\n"),
            "{content}"
        );
        assert!(!content.contains("[stated] [stated]"), "{content}");
    }

    #[tokio::test]
    async fn the_pass_drops_lines_the_model_tagged_as_observed_or_inferred() {
        let (_dir, base) = base();
        let llm = ScriptedLlm::answering(
            r#"{"memories":[{"path":"global/topics/habits.md","lines":["[observed] The repo has a CI job.","[inferred] They like Rust.","Runs in the morning."]}]}"#,
        );
        assert_eq!(pass(&base, llm).run().await, 1);
        let (content, _) = memory_store::read(&base, "global/topics/habits.md").unwrap();
        assert!(
            content.ends_with("- [stated] Runs in the morning.\n"),
            "{content}"
        );
        assert!(!content.contains("observed"), "{content}");
        assert!(!content.contains("inferred"), "{content}");
    }

    #[tokio::test]
    async fn a_fact_already_in_the_file_is_not_filed_again() {
        let (_dir, base) = base();
        memory_store::write(&base, "global/profile.md", PROFILE, "new").unwrap();
        let llm = ScriptedLlm::answering(
            r#"{"memories":[{"path":"global/profile.md","lines":["Works on the kimi-code CLI.","Lives in Berlin."]}]}"#,
        );
        assert_eq!(pass(&base, llm).run().await, 1);
        let (content, _) = memory_store::read(&base, "global/profile.md").unwrap();
        assert_eq!(
            content.matches("Works on the kimi-code CLI.").count(),
            1,
            "{content}"
        );
        assert!(
            content.ends_with("- [stated] Lives in Berlin.\n"),
            "{content}"
        );

        // A pass whose every line is already filed writes nothing at all.
        let repeat = ScriptedLlm::answering(
            r#"{"memories":[{"path":"global/profile.md","lines":["Lives in Berlin."]}]}"#,
        );
        assert_eq!(pass(&base, repeat).run().await, 0);
        let (after, _) = memory_store::read(&base, "global/profile.md").unwrap();
        assert_eq!(after, content);
    }

    #[tokio::test]
    async fn a_fenced_answer_still_parses() {
        let (_dir, base) = base();
        let llm = ScriptedLlm::answering(
            "Here you go:\n```json\n{\"memories\":[{\"path\":\"global/topics/tz.md\",\"lines\":[\"Works in CET.\"]}]}\n```",
        );
        assert_eq!(pass(&base, llm).run().await, 1);
        assert!(base.join("global/topics/tz.md").is_file());
    }

    #[tokio::test]
    async fn an_empty_or_unparseable_answer_files_nothing() {
        let (_dir, base) = base();
        assert_eq!(
            pass(&base, ScriptedLlm::answering(r#"{"memories":[]}"#))
                .run()
                .await,
            0
        );
        assert_eq!(
            pass(&base, ScriptedLlm::answering("I could not find anything."))
                .run()
                .await,
            0
        );
        assert_eq!(
            pass(
                &base,
                ScriptedLlm::answering(r#"{"memories":[{"path":"global/x.md"}]}"#)
            )
            .run()
            .await,
            0,
            "an entry with no lines is skipped"
        );
        assert!(!base.exists() || std::fs::read_dir(&base).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn a_failed_model_call_files_nothing_and_does_not_panic() {
        let (_dir, base) = base();
        assert_eq!(
            pass(&base, ScriptedLlm::failing("provider is down"))
                .run()
                .await,
            0
        );
        assert!(!base.exists());
    }

    #[tokio::test]
    async fn one_rejected_entry_does_not_stop_the_others() {
        let (_dir, base) = base();
        let llm = ScriptedLlm::answering(
            r#"{"memories":[
                {"path":"../escape.md","lines":["outside the store"]},
                {"path":"global/topics/habits.md","lines":["Runs in the morning."]},
                {"path":"projects/abc/areas/foo.md","lines":["Owns the release checklist."]}
            ]}"#,
        );
        assert_eq!(pass(&base, llm).run().await, 2);
        assert!(base.join("global/topics/habits.md").is_file());
        assert!(base.join("projects/abc/areas/foo.md").is_file());
        assert!(!base.join("../escape.md").exists());
    }

    #[tokio::test]
    async fn the_pass_never_overwrites_an_existing_file() {
        let (_dir, base) = base();
        memory_store::write(&base, "global/profile.md", PROFILE, "new").unwrap();
        let llm = ScriptedLlm::answering(
            r#"{"memories":[{"path":"global/profile.md","description":"Replaced.","lines":["Only this line."]}]}"#,
        );
        assert_eq!(pass(&base, llm).run().await, 1);
        let (content, _) = memory_store::read(&base, "global/profile.md").unwrap();
        assert!(content.contains("- [stated] Works on the kimi-code CLI."));
        assert!(content.contains("- [stated] Only this line."));
        assert!(content.contains("description: Who they are."), "{content}");
    }

    #[tokio::test]
    async fn the_pass_touches_at_most_the_entry_cap() {
        let (_dir, base) = base();
        let memories: Vec<String> = (0..MAX_ENTRIES + 4)
            .map(|i| format!(r#"{{"path":"global/topics/t{i}.md","lines":["fact {i}"]}}"#))
            .collect();
        let llm = ScriptedLlm::answering(&format!(r#"{{"memories":[{}]}}"#, memories.join(",")));
        assert_eq!(pass(&base, llm).run().await, MAX_ENTRIES);
    }

    #[tokio::test]
    async fn a_created_file_falls_back_to_the_first_line_for_its_description() {
        let (_dir, base) = base();
        let llm = ScriptedLlm::answering(
            r#"{"memories":[{"path":"global/topics/habits.md","lines":["Runs in the morning."]}]}"#,
        );
        assert_eq!(pass(&base, llm).run().await, 1);
        let (content, _) = memory_store::read(&base, "global/topics/habits.md").unwrap();
        assert!(
            content.starts_with("---\nname: habits\ndescription: Runs in the morning.\ntype: note\nsources: [chat]\naliases: []\n---\n\n"),
            "{content}"
        );
    }
}
