//! DiscussionContext — shared transcript value object for multi-agent
//! roundtables and debates.
//!
//! Pure data: stores the ordered discussion entries (speaker, agent id,
//! content, round), per-speaker position records, and auto-detected
//! cross-references, and renders the transcript / positions as text blocks
//! injected into each participant agent's prompt. Direct port of
//! `agent-core-v2/src/agent/team/context.ts`.

use regex::Regex;

/// A single speech in the discussion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscussionEntry {
    pub speaker: String,
    pub agent_id: String,
    pub content: String,
    pub round: u32,
}

/// Debate phase names, mirroring the v2 `DebatePhase` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebatePhase {
    Opening,
    FreeDebate,
    Closing,
    Consensus,
}

impl DebatePhase {
    /// Wire name used in phase breakdowns and rendered output.
    pub fn as_str(&self) -> &'static str {
        match self {
            DebatePhase::Opening => "opening",
            DebatePhase::FreeDebate => "free_debate",
            DebatePhase::Closing => "closing",
            DebatePhase::Consensus => "consensus",
        }
    }

    /// Human-readable label used in the debate transcript markers.
    fn label(&self) -> &'static str {
        match self {
            DebatePhase::Opening => "Opening Statements",
            DebatePhase::FreeDebate => "Free Debate",
            DebatePhase::Closing => "Closing Arguments",
            DebatePhase::Consensus => "Consensus & Resolution",
        }
    }
}

/// A participant's stated position on the topic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionRecord {
    pub speaker: String,
    pub stance: String,
    pub key_points: Vec<String>,
    pub round: u32,
}

/// Stance classification of a detected cross-reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrossReferenceStance {
    Agree,
    Disagree,
    Clarify,
    Extend,
}

impl CrossReferenceStance {
    pub fn as_str(&self) -> &'static str {
        match self {
            CrossReferenceStance::Agree => "agree",
            CrossReferenceStance::Disagree => "disagree",
            CrossReferenceStance::Clarify => "clarify",
            CrossReferenceStance::Extend => "extend",
        }
    }
}

/// An auto-detected cross-reference from one speaker to another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrossReference {
    pub speaker: String,
    pub target_speaker: String,
    pub target_round: u32,
    pub stance: CrossReferenceStance,
    pub content: String,
    pub round: u32,
}

/// Shared transcript value object for roundtables and debates.
pub struct DiscussionContext {
    entries: Vec<DiscussionEntry>,
    positions: Vec<PositionRecord>,
    cross_refs: Vec<CrossReference>,
    current_phase: DebatePhase,
}

impl DiscussionContext {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            positions: Vec::new(),
            cross_refs: Vec::new(),
            current_phase: DebatePhase::Opening,
        }
    }

    pub fn add_entry(&mut self, speaker: &str, agent_id: &str, content: &str, round: u32) {
        self.entries.push(DiscussionEntry {
            speaker: speaker.to_string(),
            agent_id: agent_id.to_string(),
            content: content.to_string(),
            round,
        });
        self.detect_cross_references(speaker, content, round);
    }

    /// The current round number (1-based). 0 before any entry.
    pub fn get_round(&self) -> u32 {
        self.entries.last().map(|e| e.round).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn last_speaker(&self) -> Option<&str> {
        self.entries.last().map(|e| e.speaker.as_str())
    }

    pub fn latest_entry(&self) -> Option<&DiscussionEntry> {
        self.entries.last()
    }

    pub fn all_entries(&self) -> Vec<DiscussionEntry> {
        self.entries.clone()
    }

    /// Total number of entries (speeches) recorded.
    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    pub fn set_phase(&mut self, phase: DebatePhase) {
        self.current_phase = phase;
    }

    pub fn get_phase(&self) -> DebatePhase {
        self.current_phase
    }

    /// Record a participant's stated position on the topic.
    pub fn record_position(
        &mut self,
        speaker: &str,
        stance: &str,
        key_points: &[String],
        round: u32,
    ) {
        let record = PositionRecord {
            speaker: speaker.to_string(),
            stance: stance.to_string(),
            key_points: key_points.to_vec(),
            round,
        };
        if let Some(existing) = self.positions.iter_mut().find(|p| p.speaker == speaker) {
            *existing = record;
        } else {
            self.positions.push(record);
        }
    }

    /// Get the latest recorded position for a speaker.
    pub fn get_position(&self, speaker: &str) -> Option<&PositionRecord> {
        self.positions.iter().find(|p| p.speaker == speaker)
    }

    /// All recorded positions.
    pub fn all_positions(&self) -> Vec<PositionRecord> {
        self.positions.clone()
    }

    /// All detected cross-references.
    pub fn all_cross_references(&self) -> Vec<CrossReference> {
        self.cross_refs.clone()
    }

    /// Render positions as a text block for injection into debate prompts.
    pub fn get_positions_text(&self) -> String {
        if self.positions.is_empty() {
            return String::new();
        }
        self.positions
            .iter()
            .map(|p| {
                format!(
                    "[{}] Stance: {}\n  Key points: {}",
                    p.speaker,
                    p.stance,
                    p.key_points.join(", ")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Render the full discussion transcript as a text block suitable for
    /// injection into a participant agent's context.
    pub fn get_transcript(&self) -> String {
        if self.entries.is_empty() {
            return String::new();
        }
        self.entries
            .iter()
            .map(|e| format!("[{}] {}", e.speaker, e.content))
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// Render transcript with phase markers.
    pub fn get_debate_transcript(&self) -> String {
        if self.entries.is_empty() {
            return String::new();
        }
        let mut lines: Vec<String> = Vec::new();
        let mut last_phase: Option<DebatePhase> = None;
        for entry in &self.entries {
            let phase = self.current_phase;
            if Some(phase) != last_phase {
                lines.push(format!("\n=== {} ===\n", phase.label()));
                last_phase = Some(phase);
            }
            lines.push(format!("[{}] {}", entry.speaker, entry.content));
        }
        lines.join("\n\n")
    }

    /// Detect simple cross-references in speech content: patterns like
    /// "@Speaker", "as Speaker said", "Speaker's point".
    fn detect_cross_references(&mut self, speaker: &str, content: &str, round: u32) {
        let mut seen = std::collections::HashSet::new();
        for entry in &self.entries {
            if !seen.insert(entry.speaker.clone()) {
                continue;
            }
            let target = &entry.speaker;
            if target == speaker {
                continue;
            }
            let escaped = escape_regex(target);
            let ref_patterns = [
                format!(r"(?i)@{escaped}"),
                format!(r"(?i)as {escaped} (said|mentioned|argued|pointed out)"),
                format!(r"(?i){escaped}['’]s (point|argument|suggestion|idea|proposal)"),
                format!(r"(?i)(agree|disagree) with {escaped}"),
                format!(r"(?i)(building|expanding) on {escaped}"),
            ];
            let found = ref_patterns.iter().any(|p| re_matches(content, p));
            if !found {
                continue;
            }

            let mut stance = CrossReferenceStance::Clarify;
            if contains_word(content, "agree")
                || contains_word(content, "support")
                || contains_word(content, "second")
            {
                stance = CrossReferenceStance::Agree;
            } else if contains_word(content, "disagree")
                || re_matches(content, r"(?i)\brespectfully\b.*\bdisagree\b")
                || contains_word(content, "counter")
                || re_matches(content, r"(?i)\bpush back\b")
            {
                stance = CrossReferenceStance::Disagree;
            } else if contains_word(content, "extend")
                || re_matches(content, r"(?i)\bbuild(?:ing)? on\b")
                || re_matches(content, r"(?i)\bad[d]?\b.*\bpoint\b")
            {
                stance = CrossReferenceStance::Extend;
            }

            self.cross_refs.push(CrossReference {
                speaker: speaker.to_string(),
                target_speaker: target.clone(),
                target_round: if round >= 2 { round - 1 } else { 1 },
                stance,
                content: content.chars().take(200).collect(),
                round,
            });
        }
    }
}

impl Default for DiscussionContext {
    fn default() -> Self {
        Self::new()
    }
}

fn contains_word(content: &str, word: &str) -> bool {
    re_matches(content, &format!(r"(?i)\b{word}\b"))
}

fn re_matches(content: &str, pattern: &str) -> bool {
    Regex::new(pattern)
        .expect("regex pattern must compile")
        .is_match(content)
}

fn escape_regex(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(
            c,
            '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_entries_and_transcript() {
        let mut ctx = DiscussionContext::new();
        assert!(ctx.is_empty());
        assert_eq!(ctx.get_round(), 0);
        assert_eq!(ctx.last_speaker(), None);
        assert_eq!(ctx.latest_entry(), None);

        ctx.add_entry("alice", "a1", "Hello everyone.", 1);
        ctx.add_entry("bob", "b1", "Hi alice.", 1);

        assert_eq!(ctx.entry_count(), 2);
        assert_eq!(ctx.get_round(), 1);
        assert_eq!(ctx.last_speaker(), Some("bob"));
        assert_eq!(ctx.latest_entry().unwrap().content, "Hi alice.");
        assert_eq!(
            ctx.get_transcript(),
            "[alice] Hello everyone.\n\n[bob] Hi alice."
        );
    }

    #[test]
    fn test_cross_reference_mention_and_stance() {
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("alice", "a1", "I support the plan.", 1);
        ctx.add_entry("bob", "b1", "I agree with alice's point.", 1);

        let refs = ctx.all_cross_references();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].speaker, "bob");
        assert_eq!(refs[0].target_speaker, "alice");
        assert_eq!(refs[0].stance, CrossReferenceStance::Agree);
        assert_eq!(refs[0].target_round, 1);
        assert_eq!(refs[0].round, 1);
    }

    #[test]
    fn test_cross_reference_patterns() {
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("alice", "a1", "First.", 1);
        ctx.add_entry("bob", "b1", "As alice said, we should wait.", 1);
        ctx.add_entry("carol", "c1", "@alice what about cost?", 2);
        ctx.add_entry("dave", "d1", "Building on alice's idea, let's plan.", 2);

        let refs = ctx.all_cross_references();
        assert_eq!(refs.len(), 3);
        assert_eq!(refs[0].stance, CrossReferenceStance::Clarify);
        assert_eq!(refs[1].stance, CrossReferenceStance::Clarify);
        assert_eq!(refs[2].stance, CrossReferenceStance::Extend);
        assert_eq!(refs[2].target_round, 1);
    }

    #[test]
    fn test_cross_reference_disagree_and_later_round() {
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("alice", "a1", "First.", 1);
        ctx.add_entry("bob", "b1", "I disagree with alice.", 1);
        ctx.add_entry("carol", "c1", "I push back on bob's argument.", 2);

        let refs = ctx.all_cross_references();
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].stance, CrossReferenceStance::Disagree);
        assert_eq!(refs[1].stance, CrossReferenceStance::Disagree);
        assert_eq!(refs[1].target_round, 1);
    }

    #[test]
    fn test_cross_reference_escapes_special_chars() {
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("a.b", "a1", "First.", 1);
        ctx.add_entry("bob", "b1", "I agree with a.b.", 1);

        let refs = ctx.all_cross_references();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].target_speaker, "a.b");
        assert_eq!(refs[0].stance, CrossReferenceStance::Agree);
    }

    #[test]
    fn test_no_self_reference() {
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("alice", "a1", "I agree with alice's own point.", 1);
        assert!(ctx.all_cross_references().is_empty());
    }

    #[test]
    fn test_cross_reference_content_truncated() {
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("alice", "a1", "First.", 1);
        let long = format!("@alice {}", "x".repeat(500));
        ctx.add_entry("bob", "b1", &long, 1);

        let refs = ctx.all_cross_references();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].content.len(), 200);
    }

    #[test]
    fn test_positions_record_and_replace() {
        let mut ctx = DiscussionContext::new();
        ctx.record_position("alice", "support", &["a".to_string(), "b".to_string()], 1);
        ctx.record_position("bob", "oppose", &[], 1);

        assert_eq!(ctx.all_positions().len(), 2);
        assert_eq!(ctx.get_position("alice").unwrap().stance, "support");
        assert_eq!(ctx.get_position("carol"), None);

        ctx.record_position("alice", "neutral", &[], 2);
        assert_eq!(ctx.all_positions().len(), 2);
        let alice = ctx.get_position("alice").unwrap();
        assert_eq!(alice.stance, "neutral");
        assert_eq!(alice.round, 2);

        let text = ctx.get_positions_text();
        assert!(text.contains("[alice] Stance: neutral"));
        assert!(text.contains("[bob] Stance: oppose"));
        assert!(text.contains("Key points:"));
    }

    #[test]
    fn test_debate_transcript_phase_markers() {
        let mut ctx = DiscussionContext::new();
        ctx.set_phase(DebatePhase::Opening);
        ctx.add_entry("alice", "a1", "Opening one.", 1);
        ctx.add_entry("bob", "b1", "Opening two.", 1);
        ctx.set_phase(DebatePhase::FreeDebate);
        ctx.add_entry("alice", "a1", "Rebuttal.", 2);

        // Mirrors v2: `inferPhaseForEntry` returns the context's current
        // phase for every entry, so the marker reflects the phase at render
        // time (here FreeDebate) for the whole transcript.
        let text = ctx.get_debate_transcript();
        assert!(text.starts_with("\n=== Free Debate ===\n"));
        assert!(!text.contains("Opening Statements"));
        assert!(text.contains("[bob] Opening two."));
        assert!(text.contains("[alice] Rebuttal."));
    }
}
