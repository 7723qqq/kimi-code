//! Team coordinators — roundtable discussions and structured debates among
//! persistent subagents.
//!
//! Direct port of `agent-core-v2/src/agent/team/coordinator.ts` and
//! `debate-coordinator.ts`: pure orchestration over a
//! [`PersistentSubagentHost`] trait, so the coordinators are fully testable
//! with a mock host. [`SubagentManagerHost`] wires the trait to the engine's
//! `SubagentManager` persistent interface.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use regex::Regex;

use crate::callbacks::HostCallbacks;
use crate::rpc::types::{BoxFuture, TokenUsage};
use crate::subagent::SubagentManager;
use crate::team::context::{CrossReferenceStance, DebatePhase, DiscussionContext, DiscussionEntry};
use crate::turn_loop::types::{LLM, LLMChatParams, LLMChatResponse};

/// How a discussion or debate ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndedBy {
    /// Discussion ran to its round limit (rendered as "completed").
    MaxRounds,
    /// Debate ran to completion.
    Completed,
    /// Aborted by the caller's cancellation signal.
    Cancelled,
    /// A fatal error (e.g. a spawn failure).
    Failed,
}

impl EndedBy {
    pub fn as_str(&self) -> &'static str {
        match self {
            EndedBy::MaxRounds => "max_rounds",
            EndedBy::Completed => "completed",
            EndedBy::Cancelled => "cancelled",
            EndedBy::Failed => "failed",
        }
    }
}

/// The per-caller view of the persistent-subagent lifecycle, mirroring the
/// v2 `PersistentSubagentHost` interface.
pub trait PersistentSubagentHost: Send + Sync {
    /// Spawn a persistent subagent for the given profile and role.
    fn spawn_persistent(
        &self,
        profile_name: &str,
        role_description: &str,
        parent_tool_call_id: &str,
    ) -> BoxFuture<'static, Result<String, String>>;
    /// Run one turn on a persistent instance and return the assistant text.
    fn run_discussion_turn(
        &self,
        agent_id: &str,
        prompt: &str,
    ) -> BoxFuture<'static, Result<String, String>>;
    /// Cumulative token usage of a persistent instance.
    fn get_persistent_usage(&self, agent_id: &str) -> BoxFuture<'static, TokenUsage>;
    /// Terminate and remove a persistent instance.
    fn destroy_persistent(&self, agent_id: &str) -> BoxFuture<'static, ()>;
}

/// [`PersistentSubagentHost`] backed by the engine's [`SubagentManager`]
/// persistent interface. Holds the LLM and callbacks used for every turn.
///
/// The manager's `run_persistent_turn` returns a `TurnResult` without the
/// assistant content, so the adapter records the final content of each turn
/// through a recording LLM wrapper. It is meant to be constructed per
/// coordinator run: the recorder keeps a single last-content slot.
pub struct SubagentManagerHost {
    manager: Arc<SubagentManager>,
    recorder: Arc<RecordingLlm>,
    callbacks: Arc<dyn HostCallbacks>,
}

impl SubagentManagerHost {
    pub fn new(
        manager: Arc<SubagentManager>,
        llm: Arc<dyn LLM>,
        callbacks: Arc<dyn HostCallbacks>,
    ) -> Self {
        Self {
            manager,
            recorder: Arc::new(RecordingLlm::new(llm)),
            callbacks,
        }
    }
}

impl PersistentSubagentHost for SubagentManagerHost {
    fn spawn_persistent(
        &self,
        profile_name: &str,
        role_description: &str,
        _parent_tool_call_id: &str,
    ) -> BoxFuture<'static, Result<String, String>> {
        let manager = self.manager.clone();
        let recorder = self.recorder.clone();
        let callbacks = self.callbacks.clone();
        let profile_name = profile_name.to_string();
        let role_description = role_description.to_string();
        Box::pin(async move {
            manager
                .spawn_persistent(&profile_name, &role_description, recorder, callbacks)
                .await
        })
    }

    fn run_discussion_turn(
        &self,
        agent_id: &str,
        prompt: &str,
    ) -> BoxFuture<'static, Result<String, String>> {
        let manager = self.manager.clone();
        let recorder = self.recorder.clone();
        let callbacks = self.callbacks.clone();
        let agent_id = agent_id.to_string();
        let prompt = prompt.to_string();
        Box::pin(async move {
            manager
                .run_persistent_turn(&agent_id, &prompt, recorder.clone(), callbacks)
                .await?;
            Ok(recorder.last_content().unwrap_or_default())
        })
    }

    fn get_persistent_usage(&self, agent_id: &str) -> BoxFuture<'static, TokenUsage> {
        let manager = self.manager.clone();
        let agent_id = agent_id.to_string();
        Box::pin(async move { manager.get_persistent_usage(&agent_id).await })
    }

    fn destroy_persistent(&self, agent_id: &str) -> BoxFuture<'static, ()> {
        let manager = self.manager.clone();
        let agent_id = agent_id.to_string();
        Box::pin(async move {
            let _ = manager.destroy_persistent(&agent_id).await;
        })
    }
}

/// Configuration for a single discussion participant.
#[derive(Debug, Clone)]
pub struct DiscussionParticipantConfig {
    /// Agent profile name, e.g. 'researcher', 'coder', 'explore'.
    pub profile_name: String,
    /// Distinct speaker name used for transcript/stance/cross-reference
    /// bookkeeping; defaults to the profile name.
    pub speaker_name: Option<String>,
    /// Role description injected into the agent's prompt each turn.
    pub role_description: String,
    /// How many times this participant speaks per round (default: 1).
    pub turns_per_round: Option<u32>,
}

/// Options for starting a roundtable discussion.
#[derive(Debug, Clone)]
pub struct DiscussionOptions {
    /// The topic or question to discuss.
    pub topic: String,
    /// The participants in the discussion.
    pub participants: Vec<DiscussionParticipantConfig>,
    /// Maximum number of full rounds before the discussion ends (default: 3).
    pub max_rounds: Option<u32>,
    /// Optional prompt used to generate a final summary after the discussion.
    pub summary_prompt: Option<String>,
}

/// The result of a completed discussion.
#[derive(Debug, Clone)]
pub struct DiscussionResult {
    /// Ordered list of every speech in the discussion.
    pub transcript: Vec<DiscussionEntry>,
    /// A final summary (empty string if none was generated).
    pub summary: String,
    /// How many full rounds were completed.
    pub rounds_completed: u32,
    /// How the discussion ended.
    pub ended_by: EndedBy,
    /// Aggregate token usage across all participants.
    pub usage: TokenUsage,
}

/// A single turn event, emitted so external code (e.g. the TUI) can observe
/// each turn as it happens.
#[derive(Debug, Clone)]
pub struct DiscussionTurnEvent {
    pub agent_id: String,
    pub role_name: String,
    pub round: u32,
    pub content: String,
}

pub type DiscussionObserver = Arc<dyn Fn(&DiscussionTurnEvent) + Send + Sync>;

/// TeamCoordinator — orchestrates a roundtable discussion among multiple
/// persistent subagents.
///
/// Each participant is a persistent subagent that receives the full
/// discussion transcript before their turn. They speak naturally, like a
/// human in a roundtable, with no special tools or communication primitives.
pub struct TeamCoordinator<H: PersistentSubagentHost> {
    host: H,
    agent_ids: Vec<String>,
    observer: Option<DiscussionObserver>,
}

impl<H: PersistentSubagentHost> TeamCoordinator<H> {
    pub fn new(host: H, observer: Option<DiscussionObserver>) -> Self {
        Self {
            host,
            agent_ids: Vec::new(),
            observer,
        }
    }

    /// Run a roundtable discussion and return the result.
    pub async fn discuss(
        &mut self,
        options: &DiscussionOptions,
        cancelled: &AtomicBool,
    ) -> DiscussionResult {
        let max_rounds = options.max_rounds.unwrap_or(3);
        let mut context = DiscussionContext::new();
        let mut ended_by = EndedBy::MaxRounds;
        let mut rounds_completed = 0u32;
        let mut summary = String::new();

        let outcome: Result<(), String> = async {
            for participant in &options.participants {
                throw_if_aborted(cancelled)?;
                let agent_id = self
                    .host
                    .spawn_persistent(
                        &participant.profile_name,
                        &participant.role_description,
                        "discussion",
                    )
                    .await?;
                self.agent_ids.push(agent_id);
            }

            for round in 1..=max_rounds {
                throw_if_aborted(cancelled)?;
                for (index, participant) in options.participants.iter().enumerate() {
                    throw_if_aborted(cancelled)?;
                    let agent_id = &self.agent_ids[index];
                    let turns_this_round = participant.turns_per_round.unwrap_or(1);
                    for _ in 0..turns_this_round {
                        throw_if_aborted(cancelled)?;
                        let prompt = self.build_turn_prompt(
                            &participant.role_description,
                            &options.topic,
                            &context,
                        );
                        let content = match self.host.run_discussion_turn(agent_id, &prompt).await {
                            Ok(content) => content,
                            Err(error) => {
                                if is_cancelled(&error, cancelled) {
                                    return Err(error);
                                }
                                turn_failure_message(&error)
                            }
                        };
                        let speaker = participant
                            .speaker_name
                            .clone()
                            .unwrap_or_else(|| participant.profile_name.clone());
                        context.add_entry(&speaker, agent_id, &content, round);
                        if let Some(observer) = &self.observer {
                            observer(&DiscussionTurnEvent {
                                agent_id: agent_id.clone(),
                                role_name: speaker,
                                round,
                                content,
                            });
                        }
                    }
                }
                rounds_completed = round;
            }

            if let Some(summary_prompt) = &options.summary_prompt
                && !context.is_empty()
            {
                summary = self.generate_summary(summary_prompt, &context).await;
            }
            Ok(())
        }
        .await;

        if let Err(error) = outcome {
            ended_by = if is_cancelled(&error, cancelled) {
                EndedBy::Cancelled
            } else {
                EndedBy::Failed
            };
            rounds_completed = context.get_round();
            summary = String::new();
        }

        let usage = self.collect_usage().await;
        self.destroy_all().await;

        DiscussionResult {
            transcript: context.all_entries(),
            summary,
            rounds_completed,
            ended_by,
            usage,
        }
    }

    /// Build the prompt for a single participant's turn.
    fn build_turn_prompt(
        &self,
        role_description: &str,
        topic: &str,
        context: &DiscussionContext,
    ) -> String {
        let mut parts: Vec<String> = Vec::new();

        parts.push(format!("[System] Your role:\n{role_description}"));
        parts.push(String::new());
        parts.push(format!("Discussion topic:\n{topic}"));
        parts.push(String::new());

        let transcript = context.get_transcript();
        if !transcript.is_empty() {
            parts.push("Current discussion transcript:".to_string());
            parts.push(transcript);
            parts.push(String::new());
            parts.push(
                "Continue the discussion based on what has been said so far. \
                 Respond naturally, as if you are in a roundtable conversation."
                    .to_string(),
            );
        } else {
            parts.push(
                "You are the first to speak. Present your initial thoughts on the topic."
                    .to_string(),
            );
        }

        parts.join("\n")
    }

    /// Generate a final summary by running a turn on the first participant.
    async fn generate_summary(&self, summary_prompt: &str, context: &DiscussionContext) -> String {
        let Some(first_agent_id) = self.agent_ids.first() else {
            return String::new();
        };
        let prompt = [
            summary_prompt.to_string(),
            String::new(),
            "Full discussion transcript:".to_string(),
            context.get_transcript(),
            String::new(),
            "Please provide a concise summary of the discussion.".to_string(),
        ]
        .join("\n");

        self.host
            .run_discussion_turn(first_agent_id, &prompt)
            .await
            .unwrap_or_default()
    }

    /// Aggregate token usage across all participants.
    async fn collect_usage(&self) -> TokenUsage {
        let mut total: Option<TokenUsage> = None;
        for agent_id in &self.agent_ids {
            let usage = self.host.get_persistent_usage(agent_id).await;
            total = Some(match total {
                Some(acc) => add_usage(&acc, &usage),
                None => usage,
            });
        }
        total.unwrap_or_default()
    }

    /// Destroy all persistent subagents.
    async fn destroy_all(&mut self) {
        for agent_id in &self.agent_ids {
            let _ = self.host.destroy_persistent(agent_id).await;
        }
        self.agent_ids.clear();
    }
}

/// Configuration for a single debate participant.
#[derive(Debug, Clone)]
pub struct DebateParticipantConfig {
    /// Agent profile name, e.g. 'researcher', 'coder', 'explore'.
    pub profile_name: String,
    /// Distinct speaker name used for transcript/stance/cross-reference
    /// bookkeeping; defaults to the profile name.
    pub speaker_name: Option<String>,
    /// Role description injected into the agent's prompt each turn.
    pub role_description: String,
    /// Optional stance this participant should take (e.g. "argue for migration").
    pub assigned_stance: Option<String>,
}

/// Options for starting a structured debate.
#[derive(Debug, Clone)]
pub struct DebateOptions {
    /// The topic or question to debate.
    pub topic: String,
    /// The participants in the debate.
    pub participants: Vec<DebateParticipantConfig>,
    /// Maximum number of free-debate rounds before closing (default: 2).
    pub max_debate_rounds: Option<u32>,
    /// Optional prompt used to generate a final summary/consensus.
    pub consensus_prompt: Option<String>,
    /// Whether to include a voting phase (default: false).
    pub enable_voting: bool,
}

/// The result of a completed debate.
#[derive(Debug, Clone)]
pub struct DebateResult {
    /// Ordered list of every speech in the debate.
    pub transcript: Vec<DiscussionEntry>,
    /// Phase-by-phase breakdown.
    pub phases: Vec<PhaseBreakdown>,
    /// A final consensus/summary (empty string if none was generated).
    pub consensus: String,
    /// Voting result (empty string if voting was not enabled).
    pub voting_result: String,
    /// How the debate ended.
    pub ended_by: EndedBy,
    /// Aggregate token usage across all participants.
    pub usage: TokenUsage,
    /// Cross-references detected during the debate.
    pub cross_references_count: u32,
    /// How many participants changed their stated position.
    pub position_changes: u32,
}

/// Entry count of a single debate phase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhaseBreakdown {
    pub phase: DebatePhase,
    pub entry_count: u32,
}

/// StructuredDebateCoordinator — orchestrates a structured, multi-phase
/// debate among multiple persistent subagents.
///
/// Phases:
///   1. Opening Statements — each participant presents their initial stance
///   2. Free Debate — participants respond to and challenge each other
///   3. Closing Arguments — each participant delivers a final summary
///   4. Consensus (optional) — extract agreed/disagreed points
pub struct StructuredDebateCoordinator<H: PersistentSubagentHost> {
    host: H,
    agent_ids: Vec<String>,
    observer: Option<DiscussionObserver>,
}

impl<H: PersistentSubagentHost> StructuredDebateCoordinator<H> {
    pub fn new(host: H, observer: Option<DiscussionObserver>) -> Self {
        Self {
            host,
            agent_ids: Vec::new(),
            observer,
        }
    }

    /// Run a structured debate and return the result.
    pub async fn debate(
        &mut self,
        options: &DebateOptions,
        cancelled: &AtomicBool,
    ) -> DebateResult {
        let mut context = DiscussionContext::new();
        let mut ended_by = EndedBy::Completed;
        let mut consensus = String::new();
        let mut voting_result = String::new();
        let mut position_changes = 0u32;

        let outcome: Result<(), String> = async {
            for participant in &options.participants {
                throw_if_aborted(cancelled)?;
                let agent_id = self
                    .host
                    .spawn_persistent(
                        &participant.profile_name,
                        &participant.role_description,
                        "debate",
                    )
                    .await?;
                self.agent_ids.push(agent_id);
            }

            let mut initial_positions: Vec<(String, String)> = Vec::new();

            context.set_phase(DebatePhase::Opening);
            for (index, participant) in options.participants.iter().enumerate() {
                throw_if_aborted(cancelled)?;
                let speaker = participant
                    .speaker_name
                    .clone()
                    .unwrap_or_else(|| participant.profile_name.clone());
                let turn = self
                    .run_opening_statement(index, participant, &options.topic, &context, cancelled)
                    .await?;
                let content = turn.content;
                context.add_entry(&speaker, &self.agent_ids[index], &content, 1);

                if turn.ok {
                    let stance = extract_stance(&content);
                    initial_positions.push((speaker.clone(), stance.clone()));
                    context.record_position(&speaker, &stance, &extract_key_points(&content), 1);
                }

                self.emit_turn(&speaker, &self.agent_ids[index], 1, &content);
            }

            context.set_phase(DebatePhase::FreeDebate);
            let max_debate_rounds = options.max_debate_rounds.unwrap_or(2);
            let round_offset = 1u32;
            for round in 1..=max_debate_rounds {
                throw_if_aborted(cancelled)?;
                let current_round = round_offset + round;

                for (index, participant) in options.participants.iter().enumerate() {
                    throw_if_aborted(cancelled)?;
                    let agent_id = &self.agent_ids[index];
                    let speaker = participant
                        .speaker_name
                        .clone()
                        .unwrap_or_else(|| participant.profile_name.clone());

                    let prompt = self.build_debate_round_prompt(
                        &participant.role_description,
                        &options.topic,
                        &speaker,
                        &context,
                        current_round,
                    );

                    let turn = self.run_debate_turn(agent_id, &prompt, cancelled).await?;
                    let content = turn.content;
                    context.add_entry(&speaker, agent_id, &content, current_round);

                    if turn.ok {
                        let new_stance = extract_stance(&content);
                        let current_stance =
                            context.get_position(&speaker).map(|p| p.stance.clone());
                        if !new_stance.is_empty()
                            && current_stance.as_deref() != Some(new_stance.as_str())
                        {
                            context.record_position(
                                &speaker,
                                &new_stance,
                                &extract_key_points(&content),
                                current_round,
                            );
                        }
                    }

                    self.emit_turn(&speaker, agent_id, current_round, &content);
                }
            }

            context.set_phase(DebatePhase::Closing);
            let closing_round = round_offset + max_debate_rounds + 1;
            for (index, participant) in options.participants.iter().enumerate() {
                throw_if_aborted(cancelled)?;
                let agent_id = &self.agent_ids[index];
                let speaker = participant
                    .speaker_name
                    .clone()
                    .unwrap_or_else(|| participant.profile_name.clone());

                let prompt = self.build_closing_prompt(
                    &participant.role_description,
                    &options.topic,
                    &speaker,
                    &context,
                    closing_round,
                );

                let turn = self.run_debate_turn(agent_id, &prompt, cancelled).await?;
                let content = turn.content;
                context.add_entry(&speaker, agent_id, &content, closing_round);

                if turn.ok {
                    let final_stance = extract_stance(&content);
                    if !final_stance.is_empty() {
                        context.record_position(
                            &speaker,
                            &final_stance,
                            &extract_key_points(&content),
                            closing_round,
                        );
                    }
                }

                self.emit_turn(&speaker, agent_id, closing_round, &content);
            }

            for (speaker, initial) in &initial_positions {
                if let Some(current) = context.get_position(speaker)
                    && current.stance.as_str() != initial.as_str()
                {
                    position_changes += 1;
                }
            }

            context.set_phase(DebatePhase::Consensus);
            if let Some(consensus_prompt) = &options.consensus_prompt
                && !context.is_empty()
            {
                consensus = self.generate_consensus(consensus_prompt, &context).await;
            }
            if options.enable_voting && !context.is_empty() {
                voting_result = self.run_voting(&options.topic, &context, cancelled).await?;
            }
            Ok(())
        }
        .await;

        if let Err(error) = outcome {
            ended_by = if is_cancelled(&error, cancelled) {
                EndedBy::Cancelled
            } else {
                EndedBy::Failed
            };
            consensus = String::new();
            voting_result = String::new();
            position_changes = 0;
        }

        let usage = self.collect_usage().await;
        let phases = build_phase_breakdown(&context);
        self.destroy_all().await;

        DebateResult {
            transcript: context.all_entries(),
            phases,
            consensus,
            voting_result,
            ended_by,
            usage,
            cross_references_count: context.all_cross_references().len() as u32,
            position_changes,
        }
    }

    async fn run_opening_statement(
        &self,
        index: usize,
        participant: &DebateParticipantConfig,
        topic: &str,
        _context: &DiscussionContext,
        cancelled: &AtomicBool,
    ) -> Result<TurnOutcome, String> {
        let agent_id = &self.agent_ids[index];
        let stance_hint = participant
            .assigned_stance
            .as_ref()
            .map(|stance| format!("\nYour assigned stance: {stance}"))
            .unwrap_or_default();

        let prompt = [
            format!("[System] Your role:\n{}", participant.role_description),
            String::new(),
            format!("Debate topic:\n{topic}"),
            String::new(),
            "=== OPENING STATEMENTS ===".to_string(),
            String::new(),
            "You are delivering your opening statement. Present your initial stance".to_string(),
            "on the topic clearly. State your position, your key arguments, and what".to_string(),
            "you believe is the most important consideration.".to_string(),
            stance_hint,
            String::new(),
            "Be thorough and persuasive — this is your chance to frame the debate.".to_string(),
        ]
        .join("\n");

        self.run_debate_turn(agent_id, &prompt, cancelled).await
    }

    async fn run_debate_turn(
        &self,
        agent_id: &str,
        prompt: &str,
        cancelled: &AtomicBool,
    ) -> Result<TurnOutcome, String> {
        match self.host.run_discussion_turn(agent_id, prompt).await {
            Ok(content) => Ok(TurnOutcome { content, ok: true }),
            Err(error) => {
                if is_cancelled(&error, cancelled) {
                    Err(error)
                } else {
                    Ok(TurnOutcome {
                        content: turn_failure_message(&error),
                        ok: false,
                    })
                }
            }
        }
    }

    fn build_debate_round_prompt(
        &self,
        role_description: &str,
        topic: &str,
        _speaker_name: &str,
        context: &DiscussionContext,
        round: u32,
    ) -> String {
        let mut parts: Vec<String> = Vec::new();

        parts.push(format!("[System] Your role:\n{role_description}"));
        parts.push(String::new());
        parts.push(format!("Debate topic:\n{topic}"));
        parts.push(String::new());

        let positions_text = context.get_positions_text();
        if !positions_text.is_empty() {
            parts.push("=== CURRENT POSITIONS ===".to_string());
            parts.push(positions_text);
            parts.push(String::new());
        }

        parts.push(format!("=== FREE DEBATE — Round {round} ==="));
        parts.push(String::new());

        let transcript = context.get_transcript();
        if !transcript.is_empty() {
            parts.push("Full debate transcript so far:".to_string());
            parts.push(transcript);
            parts.push(String::new());
            parts.push("Respond to what others have said. You may:".to_string());
            parts.push(
                "- Challenge or support specific points made by other participants".to_string(),
            );
            parts.push("- Provide counter-arguments or additional evidence".to_string());
            parts.push("- Clarify or refine your position".to_string());
            parts.push("- Point out flaws in opposing arguments".to_string());
            parts.push(String::new());
            parts.push(
                "Be specific when referring to others — mention their name and which \
                 point you are addressing. This is a fast-paced debate round."
                    .to_string(),
            );
        } else {
            parts.push("Present your arguments on the topic.".to_string());
        }

        parts.join("\n")
    }

    fn build_closing_prompt(
        &self,
        role_description: &str,
        topic: &str,
        _speaker_name: &str,
        context: &DiscussionContext,
        _round: u32,
    ) -> String {
        let positions_text = context.get_positions_text();
        let cross_refs = context.all_cross_references();
        let cross_ref_text = if cross_refs.is_empty() {
            String::new()
        } else {
            format!(
                "\nCross-references detected:\n{}",
                cross_refs
                    .iter()
                    .map(|r| format!(
                        "  [{}] → @{} ({})",
                        r.speaker,
                        r.target_speaker,
                        r.stance.as_str()
                    ))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };

        [
            format!("[System] Your role:\n{role_description}"),
            String::new(),
            format!("Debate topic:\n{topic}"),
            String::new(),
            "=== CLOSING ARGUMENTS ===".to_string(),
            String::new(),
            "The debate is concluding. Deliver your closing argument:".to_string(),
            String::new(),
            "- Summarize your position and key evidence".to_string(),
            "- Address the strongest counter-arguments raised against your view".to_string(),
            "- Explain why your position should prevail".to_string(),
            "- Be concise and impactful".to_string(),
            String::new(),
            "Current positions:".to_string(),
            positions_text,
            cross_ref_text,
            String::new(),
            "Full debate transcript:".to_string(),
            context.get_transcript(),
        ]
        .join("\n")
    }

    async fn generate_consensus(
        &self,
        consensus_prompt: &str,
        context: &DiscussionContext,
    ) -> String {
        let Some(first_agent_id) = self.agent_ids.first() else {
            return String::new();
        };
        let positions = context.all_positions();
        let positions_block = if positions.is_empty() {
            String::new()
        } else {
            format!(
                "\nFinal positions:\n{}",
                positions
                    .iter()
                    .map(|p| format!(
                        "[{}] {}\n  Key points: {}",
                        p.speaker,
                        p.stance,
                        p.key_points.join(", ")
                    ))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };

        let cross_refs = context.all_cross_references();
        let agreements = cross_refs
            .iter()
            .filter(|r| r.stance == CrossReferenceStance::Agree)
            .count();
        let disagreements = cross_refs
            .iter()
            .filter(|r| r.stance == CrossReferenceStance::Disagree)
            .count();

        let prompt = [
            consensus_prompt.to_string(),
            String::new(),
            "Full debate transcript:".to_string(),
            context.get_transcript(),
            positions_block,
            String::new(),
            format!("Agreements detected: {agreements}, Disagreements detected: {disagreements}"),
            String::new(),
            "Please provide:".to_string(),
            "1. Points of consensus (what everyone agrees on)".to_string(),
            "2. Remaining disagreements (where opinions still differ)".to_string(),
            "3. Key insights and takeaways from the debate".to_string(),
            "4. Recommended next steps or action items".to_string(),
        ]
        .join("\n");

        self.host
            .run_discussion_turn(first_agent_id, &prompt)
            .await
            .unwrap_or_default()
    }

    /// Run a voting phase where each participant votes on key questions.
    async fn run_voting(
        &self,
        topic: &str,
        context: &DiscussionContext,
        cancelled: &AtomicBool,
    ) -> Result<String, String> {
        let positions = context.all_positions();
        let cross_refs = context.all_cross_references();
        let agreements = cross_refs
            .iter()
            .filter(|r| r.stance == CrossReferenceStance::Agree)
            .count();
        let disagreements = cross_refs
            .iter()
            .filter(|r| r.stance == CrossReferenceStance::Disagree)
            .count();

        let positions_block = if positions.is_empty() {
            String::new()
        } else {
            format!(
                "\nPositions:\n{}",
                positions
                    .iter()
                    .map(|p| format!("[{}] {}", p.speaker, p.stance))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };

        let mut votes: Vec<String> = Vec::new();
        for (index, agent_id) in self.agent_ids.iter().enumerate() {
            throw_if_aborted(cancelled)?;
            let speaker_name = positions
                .get(index)
                .map(|p| p.speaker.clone())
                .unwrap_or_else(|| format!("Participant {}", index + 1));

            let prompt = [
                format!(
                    "[System] Your role:\n{}",
                    positions
                        .get(index)
                        .map(|p| p.speaker.clone())
                        .unwrap_or_default()
                ),
                String::new(),
                format!("Debate topic:\n{topic}"),
                String::new(),
                "=== VOTING PHASE ===".to_string(),
                String::new(),
                "Based on the full debate, please vote on the following:".to_string(),
                String::new(),
                positions_block.clone(),
                String::new(),
                format!(
                    "Agreements detected: {agreements}, Disagreements detected: {disagreements}"
                ),
                String::new(),
                "Full debate transcript:".to_string(),
                context.get_transcript(),
                String::new(),
                "Please respond with:".to_string(),
                "1. Your final position on the topic (yes/no/neutral with reasoning)".to_string(),
                "2. The single most convincing argument from the debate".to_string(),
                "3. A suggested compromise or path forward".to_string(),
            ]
            .join("\n");

            match self.host.run_discussion_turn(agent_id, &prompt).await {
                Ok(vote) => votes.push(format!("[{speaker_name}] {vote}")),
                Err(_) => votes.push(format!("[{speaker_name}] <vote not cast>")),
            }
        }

        let Some(first_agent_id) = self.agent_ids.first() else {
            return Ok(String::new());
        };
        if votes.is_empty() {
            return Ok(String::new());
        }

        let tally_prompt = [
            "Tally the votes from this debate and produce a final verdict.".to_string(),
            String::new(),
            "Topic:".to_string(),
            topic.to_string(),
            String::new(),
            "Votes:".to_string(),
            votes.join("\n"),
            String::new(),
            "Please provide:".to_string(),
            "1. Vote count (how many for each position)".to_string(),
            "2. The majority position".to_string(),
            "3. Key arguments that swayed the outcome".to_string(),
            "4. Final recommended decision".to_string(),
        ]
        .join("\n");

        match self
            .host
            .run_discussion_turn(first_agent_id, &tally_prompt)
            .await
        {
            Ok(content) => Ok(content),
            Err(_) => Ok(String::new()),
        }
    }

    fn emit_turn(&self, role_name: &str, agent_id: &str, round: u32, content: &str) {
        if let Some(observer) = &self.observer {
            observer(&DiscussionTurnEvent {
                agent_id: agent_id.to_string(),
                role_name: role_name.to_string(),
                round,
                content: content.to_string(),
            });
        }
    }

    /// Aggregate token usage across all participants.
    async fn collect_usage(&self) -> TokenUsage {
        let mut total: Option<TokenUsage> = None;
        for agent_id in &self.agent_ids {
            let usage = self.host.get_persistent_usage(agent_id).await;
            total = Some(match total {
                Some(acc) => add_usage(&acc, &usage),
                None => usage,
            });
        }
        total.unwrap_or_default()
    }

    /// Destroy all persistent subagents.
    async fn destroy_all(&mut self) {
        for agent_id in &self.agent_ids {
            let _ = self.host.destroy_persistent(agent_id).await;
        }
        self.agent_ids.clear();
    }
}

struct TurnOutcome {
    content: String,
    ok: bool,
}

/// The first sentence of the content, used as the speaker's stance.
fn extract_stance(content: &str) -> String {
    content
        .split(['.', '!', '?', '\n'])
        .find(|s| !s.is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Bullet ("- ", "* ", "• ") and numbered ("1. ", "2) ") lines, falling back
/// to the first sentences longer than 10 chars. Capped at 5 points.
fn extract_key_points(content: &str) -> Vec<String> {
    let marker = Regex::new(r"^[-*•]\s|^\d+[.)]\s").expect("marker regex must compile");
    let mut points: Vec<String> = Vec::new();
    for line in content.split('\n') {
        let trimmed = line.trim();
        if marker.is_match(trimmed) {
            points.push(marker.replace(trimmed, "").into_owned());
        }
    }
    if points.is_empty() {
        let sentences: Vec<String> = content
            .split(['.', '!', '?'])
            .map(|s| s.trim().to_string())
            .filter(|s| s.len() > 10)
            .collect();
        points.extend(sentences.into_iter().take(3));
    }
    points.truncate(5);
    points
}

fn build_phase_breakdown(context: &DiscussionContext) -> Vec<PhaseBreakdown> {
    let entries = context.all_entries();
    if entries.is_empty() {
        return Vec::new();
    }
    let last_round = entries.last().map(|e| e.round).unwrap_or(0);
    let opening = entries.iter().filter(|e| e.round == 1).count();
    let closing = entries.iter().filter(|e| e.round == last_round).count();
    let free_debate = entries
        .iter()
        .filter(|e| e.round > 1 && e.round < last_round)
        .count();

    let mut phases = vec![
        PhaseBreakdown {
            phase: DebatePhase::Opening,
            entry_count: opening as u32,
        },
        PhaseBreakdown {
            phase: DebatePhase::FreeDebate,
            entry_count: free_debate as u32,
        },
        PhaseBreakdown {
            phase: DebatePhase::Closing,
            entry_count: closing as u32,
        },
    ];
    phases.retain(|p| p.entry_count > 0);
    phases
}

/// Render a discussion result as the tool output block.
pub fn format_discussion_result(result: &DiscussionResult) -> String {
    let mut lines: Vec<String> = Vec::new();

    lines.push("<discussion_result>".to_string());

    let status_text = if result.ended_by == EndedBy::MaxRounds {
        "completed"
    } else {
        result.ended_by.as_str()
    };
    lines.push(format!(
        "<summary>rounds: {}, speeches: {}, status: {status_text}</summary>",
        result.rounds_completed,
        result.transcript.len()
    ));

    lines.push("<transcript>".to_string());
    for entry in &result.transcript {
        lines.push(format!("[{}] {}", entry.speaker, entry.content));
        lines.push(String::new());
    }
    lines.push("</transcript>".to_string());

    if !result.summary.is_empty() {
        lines.push("<final_summary>".to_string());
        lines.push(result.summary.clone());
        lines.push("</final_summary>".to_string());
    }

    lines.push("</discussion_result>".to_string());

    lines.join("\n")
}

/// Render a debate result as the tool output block.
pub fn format_debate_result(result: &DebateResult) -> String {
    let mut lines: Vec<String> = Vec::new();

    lines.push("<debate_result>".to_string());

    lines.push(format!(
        "<summary>speeches: {}, phases: {}, cross_refs: {}, position_changes: {}, status: {}</summary>",
        result.transcript.len(),
        result.phases.len(),
        result.cross_references_count,
        result.position_changes,
        result.ended_by.as_str()
    ));

    lines.push("<phases>".to_string());
    for phase in &result.phases {
        lines.push(format!(
            "  <phase name=\"{}\" speeches=\"{}\" />",
            phase.phase.as_str(),
            phase.entry_count
        ));
    }
    lines.push("</phases>".to_string());

    lines.push("<transcript>".to_string());
    for entry in &result.transcript {
        lines.push(format!("[{}] {}", entry.speaker, entry.content));
        lines.push(String::new());
    }
    lines.push("</transcript>".to_string());

    if !result.consensus.is_empty() {
        lines.push("<consensus>".to_string());
        lines.push(result.consensus.clone());
        lines.push("</consensus>".to_string());
    }

    if !result.voting_result.is_empty() {
        lines.push("<voting_result>".to_string());
        lines.push(result.voting_result.clone());
        lines.push("</voting_result>".to_string());
    }

    lines.push("</debate_result>".to_string());

    lines.join("\n")
}

/// Text recorded for a turn that failed with a non-cancellation error.
pub fn turn_failure_message(error: &str) -> String {
    format!("[agent error] {error}")
}

fn throw_if_aborted(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err("aborted".to_string())
    } else {
        Ok(())
    }
}

fn is_cancelled(error: &str, cancelled: &AtomicBool) -> bool {
    cancelled.load(Ordering::SeqCst) || error.to_lowercase().contains("abort")
}

fn add_usage(a: &TokenUsage, b: &TokenUsage) -> TokenUsage {
    TokenUsage {
        input_tokens: a.input_tokens + b.input_tokens,
        output_tokens: a.output_tokens + b.output_tokens,
        total_tokens: a.total_tokens + b.total_tokens,
        input_cache_read: a.input_cache_read + b.input_cache_read,
        input_cache_creation: a.input_cache_creation + b.input_cache_creation,
    }
}

/// LLM wrapper that records the content of the final assistant response so
/// the host adapter can return it from `run_discussion_turn` (the manager's
/// `run_persistent_turn` returns a `TurnResult` without content).
struct RecordingLlm {
    inner: Arc<dyn LLM>,
    last_content: Arc<Mutex<Option<String>>>,
}

impl RecordingLlm {
    fn new(inner: Arc<dyn LLM>) -> Self {
        Self {
            inner,
            last_content: Arc::new(Mutex::new(None)),
        }
    }

    fn last_content(&self) -> Option<String> {
        self.last_content.lock().unwrap().clone()
    }
}

impl LLM for RecordingLlm {
    fn system_prompt(&self) -> &str {
        self.inner.system_prompt()
    }

    fn model_name(&self) -> &str {
        self.inner.model_name()
    }

    fn is_retryable_error(&self, error: &str) -> bool {
        self.inner.is_retryable_error(error)
    }

    fn transport(&self) -> &'static str {
        self.inner.transport()
    }

    fn chat(
        &self,
        params: LLMChatParams,
    ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
        let inner = self.inner.clone();
        let last_content = self.last_content.clone();
        Box::pin(async move {
            let response = inner.chat(params).await?;
            if !response.content.is_empty() {
                *last_content.lock().unwrap() = Some(response.content.clone());
            }
            Ok(response)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::AtomicUsize;

    struct MockHostInner {
        spawned: Mutex<Vec<String>>,
        destroyed: Mutex<Vec<String>>,
        prompts: Mutex<Vec<String>>,
        usage: Mutex<HashMap<String, TokenUsage>>,
        responses: Mutex<VecDeque<String>>,
        fail_turns: AtomicUsize,
        fail_spawn: AtomicBool,
        cancel_after: AtomicUsize,
        cancel_flag: AtomicBool,
        next_id: AtomicUsize,
    }

    impl Default for MockHostInner {
        fn default() -> Self {
            Self {
                spawned: Mutex::new(Vec::new()),
                destroyed: Mutex::new(Vec::new()),
                prompts: Mutex::new(Vec::new()),
                usage: Mutex::new(HashMap::new()),
                responses: Mutex::new(VecDeque::new()),
                fail_turns: AtomicUsize::new(0),
                fail_spawn: AtomicBool::new(false),
                cancel_after: AtomicUsize::new(usize::MAX),
                cancel_flag: AtomicBool::new(false),
                next_id: AtomicUsize::new(0),
            }
        }
    }

    #[derive(Clone)]
    struct MockHost {
        inner: Arc<MockHostInner>,
    }

    impl MockHost {
        fn new() -> Self {
            Self {
                inner: Arc::new(MockHostInner::default()),
            }
        }

        fn cancel_flag(&self) -> &AtomicBool {
            &self.inner.cancel_flag
        }

        /// Set the shared cancel flag after this many turn calls.
        fn cancel_after(&self, turns: usize) {
            self.inner.cancel_after.store(turns, Ordering::SeqCst);
        }

        fn fail_next_turns(&self, turns: usize) {
            self.inner.fail_turns.store(turns, Ordering::SeqCst);
        }

        fn fail_spawn(&self) {
            self.inner.fail_spawn.store(true, Ordering::SeqCst);
        }

        fn with_responses(&self, responses: Vec<&str>) {
            *self.inner.responses.lock().unwrap() =
                responses.into_iter().map(String::from).collect();
        }

        fn spawned(&self) -> Vec<String> {
            self.inner.spawned.lock().unwrap().clone()
        }

        fn destroyed(&self) -> Vec<String> {
            self.inner.destroyed.lock().unwrap().clone()
        }

        fn prompts(&self) -> Vec<String> {
            self.inner.prompts.lock().unwrap().clone()
        }
    }

    impl PersistentSubagentHost for MockHost {
        fn spawn_persistent(
            &self,
            profile_name: &str,
            _role_description: &str,
            _parent_tool_call_id: &str,
        ) -> BoxFuture<'static, Result<String, String>> {
            let inner = self.inner.clone();
            let profile_name = profile_name.to_string();
            Box::pin(async move {
                if inner.fail_spawn.load(Ordering::SeqCst) {
                    return Err("mock spawn failure".into());
                }
                let id = format!("mock-{}", inner.next_id.fetch_add(1, Ordering::SeqCst));
                inner.spawned.lock().unwrap().push(profile_name);
                inner.usage.lock().unwrap().insert(
                    id.clone(),
                    TokenUsage {
                        input_tokens: 10,
                        output_tokens: 5,
                        total_tokens: 15,
                        input_cache_read: 0,
                        input_cache_creation: 0,
                    },
                );
                Ok(id)
            })
        }

        fn run_discussion_turn(
            &self,
            _agent_id: &str,
            prompt: &str,
        ) -> BoxFuture<'static, Result<String, String>> {
            let inner = self.inner.clone();
            let prompt = prompt.to_string();
            Box::pin(async move {
                inner.prompts.lock().unwrap().push(prompt);
                if inner.fail_turns.load(Ordering::SeqCst) > 0 {
                    inner.fail_turns.fetch_sub(1, Ordering::SeqCst);
                    return Err("mock turn failure".into());
                }
                if inner.cancel_after.fetch_sub(1, Ordering::SeqCst) == 1 {
                    inner.cancel_flag.store(true, Ordering::SeqCst);
                }
                let response = inner
                    .responses
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| "Mock response.".to_string());
                Ok(response)
            })
        }

        fn get_persistent_usage(&self, agent_id: &str) -> BoxFuture<'static, TokenUsage> {
            let inner = self.inner.clone();
            let agent_id = agent_id.to_string();
            Box::pin(async move {
                inner
                    .usage
                    .lock()
                    .unwrap()
                    .get(&agent_id)
                    .cloned()
                    .unwrap_or_default()
            })
        }

        fn destroy_persistent(&self, agent_id: &str) -> BoxFuture<'static, ()> {
            let inner = self.inner.clone();
            let agent_id = agent_id.to_string();
            Box::pin(async move {
                inner.destroyed.lock().unwrap().push(agent_id);
            })
        }
    }

    fn participant(profile: &str, speaker: &str, role: &str) -> DiscussionParticipantConfig {
        DiscussionParticipantConfig {
            profile_name: profile.into(),
            speaker_name: Some(speaker.into()),
            role_description: role.into(),
            turns_per_round: None,
        }
    }

    fn debate_participant(profile: &str, speaker: &str, role: &str) -> DebateParticipantConfig {
        DebateParticipantConfig {
            profile_name: profile.into(),
            speaker_name: Some(speaker.into()),
            role_description: role.into(),
            assigned_stance: None,
        }
    }

    #[tokio::test]
    async fn test_discussion_runs_rounds_and_destroys() {
        let host = MockHost::new();
        let mut coordinator = TeamCoordinator::new(host.clone(), None);
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = DiscussionOptions {
            topic: "Should we migrate?".into(),
            participants: vec![
                participant("coder", "alice", "Engineer"),
                participant("coder", "bob", "Reviewer"),
            ],
            max_rounds: Some(2),
            summary_prompt: None,
        };

        let result = coordinator.discuss(&options, &cancelled).await;

        assert_eq!(result.ended_by, EndedBy::MaxRounds);
        assert_eq!(result.transcript.len(), 4);
        assert_eq!(result.rounds_completed, 2);
        assert!(result.summary.is_empty());
        assert_eq!(result.transcript[0].round, 1);
        assert_eq!(result.transcript[2].round, 2);
        assert_eq!(result.transcript[0].speaker, "alice");
        assert_eq!(result.transcript[1].speaker, "bob");
        assert_eq!(host.spawned().len(), 2);
        assert_eq!(host.destroyed().len(), 2);
    }

    #[tokio::test]
    async fn test_discussion_turn_failure_falls_back() {
        let host = MockHost::new();
        host.fail_next_turns(1);
        let mut coordinator = TeamCoordinator::new(host.clone(), None);
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = DiscussionOptions {
            topic: "Should we migrate?".into(),
            participants: vec![
                participant("coder", "alice", "Engineer"),
                participant("coder", "bob", "Reviewer"),
            ],
            max_rounds: Some(1),
            summary_prompt: None,
        };

        let result = coordinator.discuss(&options, &cancelled).await;

        assert_eq!(result.ended_by, EndedBy::MaxRounds);
        assert_eq!(result.transcript.len(), 2);
        assert!(
            result.transcript[0]
                .content
                .starts_with("[agent error] mock turn failure")
        );
        assert_eq!(result.transcript[1].content, "Mock response.");
    }

    #[tokio::test]
    async fn test_discussion_usage_aggregation() {
        let host = MockHost::new();
        let mut coordinator = TeamCoordinator::new(host.clone(), None);
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = DiscussionOptions {
            topic: "Should we migrate?".into(),
            participants: vec![
                participant("coder", "alice", "Engineer"),
                participant("coder", "bob", "Reviewer"),
            ],
            max_rounds: Some(1),
            summary_prompt: None,
        };

        let result = coordinator.discuss(&options, &cancelled).await;

        assert_eq!(result.usage.input_tokens, 20);
        assert_eq!(result.usage.output_tokens, 10);
        assert_eq!(result.usage.total_tokens, 30);
    }

    #[tokio::test]
    async fn test_discussion_summary_generation() {
        let host = MockHost::new();
        let mut coordinator = TeamCoordinator::new(host.clone(), None);
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = DiscussionOptions {
            topic: "Should we migrate?".into(),
            participants: vec![
                participant("coder", "alice", "Engineer"),
                participant("coder", "bob", "Reviewer"),
            ],
            max_rounds: Some(1),
            summary_prompt: Some("Summarize the discussion.".into()),
        };

        let result = coordinator.discuss(&options, &cancelled).await;

        assert_eq!(result.summary, "Mock response.");
        let prompts = host.prompts();
        assert!(
            prompts
                .last()
                .unwrap()
                .contains("Please provide a concise summary")
        );
    }

    #[tokio::test]
    async fn test_discussion_cancellation() {
        let host = MockHost::new();
        host.cancel_after(2);
        let mut coordinator = TeamCoordinator::new(host.clone(), None);
        let cancelled = host.cancel_flag();
        let options = DiscussionOptions {
            topic: "Should we migrate?".into(),
            participants: vec![
                participant("coder", "alice", "Engineer"),
                participant("coder", "bob", "Reviewer"),
            ],
            max_rounds: Some(3),
            summary_prompt: None,
        };

        let result = coordinator.discuss(&options, cancelled).await;

        assert_eq!(result.ended_by, EndedBy::Cancelled);
        assert_eq!(result.transcript.len(), 2);
        assert_eq!(result.rounds_completed, 1);
        assert!(result.summary.is_empty());
        assert_eq!(host.destroyed().len(), 2);
    }

    #[tokio::test]
    async fn test_discussion_spawn_failure() {
        let host = MockHost::new();
        host.fail_spawn();
        let mut coordinator = TeamCoordinator::new(host.clone(), None);
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = DiscussionOptions {
            topic: "Should we migrate?".into(),
            participants: vec![
                participant("coder", "alice", "Engineer"),
                participant("coder", "bob", "Reviewer"),
            ],
            max_rounds: Some(1),
            summary_prompt: None,
        };

        let result = coordinator.discuss(&options, &cancelled).await;

        assert_eq!(result.ended_by, EndedBy::Failed);
        assert!(result.transcript.is_empty());
        assert_eq!(result.rounds_completed, 0);
        assert!(host.destroyed().is_empty());
    }

    #[tokio::test]
    async fn test_discussion_observer() {
        let host = MockHost::new();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let observer: DiscussionObserver = Arc::new(move |event: &DiscussionTurnEvent| {
            sink.lock().unwrap().push(event.clone());
        });
        let mut coordinator = TeamCoordinator::new(host.clone(), Some(observer));
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = DiscussionOptions {
            topic: "Should we migrate?".into(),
            participants: vec![
                participant("coder", "alice", "Engineer"),
                participant("coder", "bob", "Reviewer"),
            ],
            max_rounds: Some(1),
            summary_prompt: None,
        };

        coordinator.discuss(&options, &cancelled).await;

        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].role_name, "alice");
        assert_eq!(events[0].round, 1);
        assert_eq!(events[1].role_name, "bob");
    }

    #[tokio::test]
    async fn test_discussion_turn_prompt_includes_transcript() {
        let host = MockHost::new();
        let mut coordinator = TeamCoordinator::new(host.clone(), None);
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = DiscussionOptions {
            topic: "Should we migrate?".into(),
            participants: vec![
                participant("coder", "alice", "Engineer"),
                participant("coder", "bob", "Reviewer"),
            ],
            max_rounds: Some(1),
            summary_prompt: None,
        };

        coordinator.discuss(&options, &cancelled).await;

        let prompts = host.prompts();
        assert_eq!(prompts.len(), 2);
        assert!(prompts[0].contains("You are the first to speak"));
        assert!(prompts[1].contains("[alice] Mock response."));
        assert!(prompts[1].contains("Discussion topic:\nShould we migrate?"));
    }

    #[tokio::test]
    async fn test_debate_consensus_and_position_changes() {
        let host = MockHost::new();
        host.with_responses(vec![
            "I support the migration. This is my key argument.", // alice opening
            "I disagree with alice's proposal. Migration is risky.", // bob opening
            "I extend my earlier point. More evidence arrives.", // alice free debate
            "I agree with alice now. The evidence is clear.",    // bob free debate
            "My final position is support.",                     // alice closing
            "My final position is support too.",                 // bob closing
            "Consensus reached: migrate carefully.",             // consensus
        ]);
        let mut coordinator = StructuredDebateCoordinator::new(host.clone(), None);
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = DebateOptions {
            topic: "Should we migrate?".into(),
            participants: vec![
                debate_participant("coder", "alice", "Engineer"),
                debate_participant("coder", "bob", "Reviewer"),
            ],
            max_debate_rounds: Some(1),
            consensus_prompt: Some("Summarize the debate.".into()),
            enable_voting: false,
        };

        let result = coordinator.debate(&options, &cancelled).await;

        assert_eq!(result.ended_by, EndedBy::Completed);
        assert_eq!(result.transcript.len(), 6);
        assert_eq!(result.cross_references_count, 2);
        assert_eq!(result.position_changes, 2);
        assert_eq!(result.consensus, "Consensus reached: migrate carefully.");
        assert!(result.voting_result.is_empty());
        assert_eq!(result.phases.len(), 3);
        assert_eq!(result.phases[0].phase, DebatePhase::Opening);
        assert_eq!(result.phases[0].entry_count, 2);
        assert_eq!(result.phases[1].phase, DebatePhase::FreeDebate);
        assert_eq!(result.phases[1].entry_count, 2);
        assert_eq!(result.phases[2].phase, DebatePhase::Closing);
        assert_eq!(result.phases[2].entry_count, 2);
        assert_eq!(host.destroyed().len(), 2);
    }

    #[tokio::test]
    async fn test_debate_voting() {
        let host = MockHost::new();
        host.with_responses(vec![
            "I support X.",                  // alice opening
            "I oppose X.",                   // bob opening
            "I support X strongly.",         // alice free debate
            "I still oppose X.",             // bob free debate
            "Final: support X.",             // alice closing
            "Final: oppose X.",              // bob closing
            "Consensus text.",               // consensus
            "My vote: yes.",                 // alice vote
            "My vote: no.",                  // bob vote
            "Verdict: majority supports X.", // tally
        ]);
        let mut coordinator = StructuredDebateCoordinator::new(host.clone(), None);
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = DebateOptions {
            topic: "Should we adopt X?".into(),
            participants: vec![
                debate_participant("coder", "alice", "Engineer"),
                debate_participant("coder", "bob", "Reviewer"),
            ],
            max_debate_rounds: Some(1),
            consensus_prompt: Some("Summarize.".into()),
            enable_voting: true,
        };

        let result = coordinator.debate(&options, &cancelled).await;

        assert_eq!(result.ended_by, EndedBy::Completed);
        assert_eq!(result.consensus, "Consensus text.");
        assert_eq!(result.voting_result, "Verdict: majority supports X.");
        let prompts = host.prompts();
        let tally = prompts.last().unwrap();
        assert!(tally.contains("[alice] My vote: yes."));
        assert!(tally.contains("[bob] My vote: no."));
        assert_eq!(host.destroyed().len(), 2);
    }

    #[tokio::test]
    async fn test_debate_cancellation() {
        let host = MockHost::new();
        host.cancel_after(1);
        let mut coordinator = StructuredDebateCoordinator::new(host.clone(), None);
        let cancelled = host.cancel_flag();
        let options = DebateOptions {
            topic: "Should we migrate?".into(),
            participants: vec![
                debate_participant("coder", "alice", "Engineer"),
                debate_participant("coder", "bob", "Reviewer"),
            ],
            max_debate_rounds: Some(1),
            consensus_prompt: None,
            enable_voting: false,
        };

        let result = coordinator.debate(&options, cancelled).await;

        assert_eq!(result.ended_by, EndedBy::Cancelled);
        assert_eq!(result.transcript.len(), 1);
        assert!(result.consensus.is_empty());
        assert_eq!(result.position_changes, 0);
        assert_eq!(host.destroyed().len(), 2);
    }

    #[test]
    fn test_extract_stance_and_key_points() {
        assert_eq!(
            extract_stance("I support the plan. More detail."),
            "I support the plan"
        );
        // Mirrors v2: a whitespace-only first segment survives `filter(Boolean)`
        // and trims to an empty stance.
        assert_eq!(extract_stance("   \n\nSecond sentence."), "");
        assert_eq!(
            extract_stance("  First sentence.  \nSecond."),
            "First sentence"
        );
        assert_eq!(extract_stance(""), "");

        let points = extract_key_points(
            "- point one\n* point two\n• point three\n1. point four\n2) point five\nplain",
        );
        assert_eq!(
            points,
            vec![
                "point one",
                "point two",
                "point three",
                "point four",
                "point five"
            ]
        );

        let fallback = extract_key_points("A sentence longer than ten chars. Another one too.");
        assert_eq!(fallback.len(), 2);
    }

    #[test]
    fn test_format_discussion_result() {
        let result = DiscussionResult {
            transcript: vec![DiscussionEntry {
                speaker: "alice".into(),
                agent_id: "a1".into(),
                content: "Hello.".into(),
                round: 1,
            }],
            summary: "We agreed.".into(),
            rounds_completed: 1,
            ended_by: EndedBy::MaxRounds,
            usage: TokenUsage::default(),
        };

        let text = format_discussion_result(&result);
        assert_eq!(
            text,
            "<discussion_result>\n\
             <summary>rounds: 1, speeches: 1, status: completed</summary>\n\
             <transcript>\n\
             [alice] Hello.\n\
             \n\
             </transcript>\n\
             <final_summary>\n\
             We agreed.\n\
             </final_summary>\n\
             </discussion_result>"
        );
    }

    #[test]
    fn test_format_discussion_result_cancelled() {
        let result = DiscussionResult {
            transcript: Vec::new(),
            summary: String::new(),
            rounds_completed: 0,
            ended_by: EndedBy::Cancelled,
            usage: TokenUsage::default(),
        };

        let text = format_discussion_result(&result);
        assert!(text.contains("status: cancelled"));
        assert!(!text.contains("<final_summary>"));
    }

    #[test]
    fn test_format_debate_result() {
        let result = DebateResult {
            transcript: vec![DiscussionEntry {
                speaker: "alice".into(),
                agent_id: "a1".into(),
                content: "Hi.".into(),
                round: 1,
            }],
            phases: vec![PhaseBreakdown {
                phase: DebatePhase::Opening,
                entry_count: 1,
            }],
            consensus: "Consensus.".into(),
            voting_result: String::new(),
            ended_by: EndedBy::Completed,
            usage: TokenUsage::default(),
            cross_references_count: 0,
            position_changes: 0,
        };

        let text = format_debate_result(&result);
        let expected = "<debate_result>\n\
            <summary>speeches: 1, phases: 1, cross_refs: 0, position_changes: 0, status: completed</summary>\n\
            <phases>\n  <phase name=\"opening\" speeches=\"1\" />\n</phases>\n\
            <transcript>\n[alice] Hi.\n\n</transcript>\n\
            <consensus>\nConsensus.\n</consensus>\n\
            </debate_result>";
        assert_eq!(text, expected);
    }
}
