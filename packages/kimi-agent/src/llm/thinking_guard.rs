//! Thinking-stream repetition guard.
//!
//! A degenerate thinking loop is a decoding attractor, not a reasoning
//! failure. Once a short phrase has appeared a few times the model conditions
//! on its own recent output, the phrase becomes the most likely continuation,
//! and the pattern reinforces itself. Nothing inside the model notices,
//! because every step is locally the most plausible one — so the guard has to
//! live outside it.
//!
//! The guard watches the tail of the thinking stream and reports when one
//! character window has repeated often enough to be a loop rather than prose.
//! The caller stops forwarding thinking deltas once it trips. The
//! accumulator's own copy is deliberately left alone: an Anthropic thinking
//! block must round-trip to the provider with its signature intact, so this is
//! a display gate, not a content edit.
//!
//! Detection is on **character** windows, not words. A word-based n-gram needs
//! a tokenizer, and any fixed-size chunking of a long unbroken run (CJK has no
//! spaces) only lines up with the repetition when the period happens to be a
//! multiple of the chunk size — so a Chinese loop would slip through. A
//! character window has no such alignment requirement: a phrase repeated every
//! `p` characters produces an identical window at every offset that is a
//! multiple of `p`, whatever `p` is.

use std::collections::HashMap;

/// Tuning for [`ThinkingGuard`]. The defaults are calibrated for prose: a
/// 16-character window repeated six times inside a 2000-character tail is a
/// loop, while ordinary reasoning rarely repeats any 16-character run more
/// than twice.
#[derive(Debug, Clone, Copy)]
pub struct ThinkingGuardConfig {
    /// Characters of thinking kept for inspection.
    pub window_chars: usize,
    /// Characters per compared window.
    pub ngram_chars: usize,
    /// Occurrences of one window that trip the guard.
    pub repeat_threshold: usize,
    /// Thinking shorter than this is never judged — too little signal.
    pub min_chars: usize,
    /// Re-count only after this many new characters, so the scan cost stays
    /// proportional to the stream rather than to the number of deltas.
    pub check_every_chars: usize,
}

impl Default for ThinkingGuardConfig {
    fn default() -> Self {
        Self {
            window_chars: 2000,
            ngram_chars: 16,
            repeat_threshold: 6,
            min_chars: 240,
            check_every_chars: 256,
        }
    }
}

/// Whether a thinking delta should reach the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingVerdict {
    Forward,
    /// The guard has tripped: this delta is part of the loop and is dropped.
    Suppressed,
}

/// `KIMI_AGENT_THINKING_GUARD=0` turns the guard off process-wide.
pub const GUARD_ENV: &str = "KIMI_AGENT_THINKING_GUARD";

/// The `[experimental]` key the engine reads to drive [`set_enabled`].
pub const GUARD_CONFIG_KEY: &str = "thinking_repeat_guard";

static ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Turn the guard on or off. The engine drives this from
/// `[experimental].thinking_repeat_guard`; the env override still wins.
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

/// Whether the guard runs. `KIMI_AGENT_THINKING_GUARD` overrides the
/// configured value, so a single run can be compared with and without it.
pub fn enabled() -> bool {
    match std::env::var(GUARD_ENV) {
        Ok(raw) => !matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        ),
        Err(_) => ENABLED.load(std::sync::atomic::Ordering::Relaxed),
    }
}

/// Watches one thinking stream. A guard is per response — a new request starts
/// a new stream and a new guard.
#[derive(Debug)]
pub struct ThinkingGuard {
    config: ThinkingGuardConfig,
    tail: String,
    tripped: bool,
    chars_since_check: usize,
    disabled: bool,
}

impl ThinkingGuard {
    pub fn new(config: ThinkingGuardConfig) -> Self {
        Self {
            config,
            tail: String::new(),
            tripped: false,
            chars_since_check: 0,
            disabled: false,
        }
    }

    /// A guard honouring the process setting — see [`enabled`]. A disabled
    /// guard forwards everything and never accumulates.
    pub fn from_settings() -> Self {
        let mut guard = Self::new(ThinkingGuardConfig::default());
        guard.disabled = !enabled();
        guard
    }

    /// Whether the guard has tripped. Once true it stays true until
    /// [`Self::reset`].
    pub fn tripped(&self) -> bool {
        self.tripped
    }

    /// Feed one thinking delta and learn whether to forward it.
    pub fn observe(&mut self, delta: &str) -> ThinkingVerdict {
        if self.disabled {
            return ThinkingVerdict::Forward;
        }
        if self.tripped {
            return ThinkingVerdict::Suppressed;
        }
        self.tail.push_str(delta);
        self.trim_tail();
        self.chars_since_check += delta.chars().count();
        if self.tail.chars().count() < self.config.min_chars
            || self.chars_since_check < self.config.check_every_chars
        {
            return ThinkingVerdict::Forward;
        }
        self.chars_since_check = 0;
        if self.most_repeated_window() >= self.config.repeat_threshold {
            self.tripped = true;
            return ThinkingVerdict::Suppressed;
        }
        ThinkingVerdict::Forward
    }

    /// Start a fresh thinking block. A text delta means the previous one ended,
    /// so a loop in it must not suppress the next block's opening.
    pub fn reset(&mut self) {
        self.tail.clear();
        self.tripped = false;
        self.chars_since_check = 0;
    }

    /// Drop everything but the last `window_chars` characters, on a char
    /// boundary.
    fn trim_tail(&mut self) {
        let limit = self.config.window_chars;
        let len = self.tail.chars().count();
        if len <= limit {
            return;
        }
        let cut = len - limit;
        let byte = self
            .tail
            .char_indices()
            .nth(cut)
            .map(|(index, _)| index)
            .unwrap_or(0);
        self.tail.drain(..byte);
    }

    /// The highest occurrence count of any character window in the tail.
    fn most_repeated_window(&self) -> usize {
        let n = self.config.ngram_chars;
        if n == 0 {
            return 0;
        }
        let chars: Vec<char> = self.tail.chars().collect();
        if chars.len() < n {
            return 0;
        }
        let mut counts: HashMap<&[char], usize> = HashMap::new();
        let mut max = 0;
        for window in chars.windows(n) {
            let count = counts.entry(window).or_insert(0);
            *count += 1;
            if *count > max {
                max = *count;
            }
        }
        max
    }
}

/// Gate one decoded delta through the guard.
///
/// `None` means the delta is part of a degenerate thinking loop and must not
/// reach the host. A text delta ends the thinking block, so it resets the
/// guard — a loop in one block must not suppress the next block's opening.
pub fn gate_delta(
    guard: &mut ThinkingGuard,
    delta: crate::llm::wire::StreamDelta,
) -> Option<crate::llm::wire::StreamDelta> {
    use crate::llm::wire::StreamDelta;
    match delta {
        StreamDelta::Think(text) => match guard.observe(&text) {
            ThinkingVerdict::Forward => Some(StreamDelta::Think(text)),
            ThinkingVerdict::Suppressed => None,
        },
        StreamDelta::Text(text) => {
            guard.reset();
            Some(StreamDelta::Text(text))
        }
        // A tool-call fragment belongs to neither channel: the guard neither
        // observes nor suppresses it.
        other => Some(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::wire::StreamDelta;

    fn guard() -> ThinkingGuard {
        ThinkingGuard::new(ThinkingGuardConfig::default())
    }

    /// Feed a whole string in small deltas, the way a stream arrives. Chunks
    /// are cut on char boundaries — a byte split would corrupt multi-byte
    /// characters and the guard would be judging replacement glyphs.
    fn feed(guard: &mut ThinkingGuard, text: &str) -> usize {
        let mut suppressed = 0;
        let chars: Vec<char> = text.chars().collect();
        for chunk in chars.chunks(16) {
            let piece: String = chunk.iter().collect();
            if guard.observe(&piece) == ThinkingVerdict::Suppressed {
                suppressed += 1;
            }
        }
        suppressed
    }

    #[test]
    fn ordinary_reasoning_is_forwarded() {
        let mut g = guard();
        let text = "The user wants the failing test fixed. I should read the \
                    assertion first, then check whether the fixture is stale. \
                    The error mentions a missing field, so the wire shape is \
                    probably wrong. Let me look at the struct definition and \
                    compare it with what the callback returns. If the field \
                    names differ, the fix belongs on the callback side.";
        assert_eq!(feed(&mut g, text), 0);
        assert!(!g.tripped());
    }

    #[test]
    fn a_repeated_phrase_trips_the_guard() {
        let mut g = guard();
        let text = "Let me check. ".repeat(60);
        assert!(feed(&mut g, &text) > 0);
        assert!(g.tripped());
    }

    #[test]
    fn a_cjk_loop_trips_the_guard() {
        let mut g = guard();
        // No whitespace at all, and the period (17 chars) is not a multiple of
        // any chunk size — a word- or chunk-based tokenizer would miss it.
        let text = "让我检查一下这个文件的内容是否正确".repeat(40);
        assert!(feed(&mut g, &text) > 0);
        assert!(g.tripped());
    }

    #[test]
    fn once_tripped_every_later_delta_is_suppressed() {
        let mut g = guard();
        feed(&mut g, &"Let me check. ".repeat(60));
        assert!(g.tripped());
        assert_eq!(
            g.observe("and now something entirely new"),
            ThinkingVerdict::Suppressed
        );
    }

    #[test]
    fn reset_clears_the_trip() {
        let mut g = guard();
        feed(&mut g, &"Let me check. ".repeat(60));
        assert!(g.tripped());
        g.reset();
        assert!(!g.tripped());
        assert_eq!(
            g.observe("A fresh thinking block begins here."),
            ThinkingVerdict::Forward
        );
    }

    #[test]
    fn short_thinking_is_never_judged() {
        let mut g = guard();
        // Below `min_chars`, even a blatant repeat is forwarded: there is not
        // enough signal to call it a loop.
        assert_eq!(feed(&mut g, &"Let me check. ".repeat(8)), 0);
        assert!(!g.tripped());
    }

    #[test]
    fn the_tail_is_bounded() {
        let mut g = guard();
        feed(&mut g, &"word ".repeat(2000));
        assert!(g.tail.chars().count() <= ThinkingGuardConfig::default().window_chars);
    }

    #[test]
    fn a_repeat_that_never_reaches_the_threshold_is_forwarded() {
        let mut g = guard();
        // Five occurrences is one short of the threshold: a phrase the model
        // came back to a few times is prose, not a loop.
        let text = format!(
            "{}and then it moved on to other work entirely.",
            "Let me check. ".repeat(5)
        );
        assert_eq!(feed(&mut g, &text), 0);
        assert!(!g.tripped());
    }

    #[test]
    fn a_disabled_guard_forwards_everything() {
        let mut g = guard();
        g.disabled = true;
        assert_eq!(feed(&mut g, &"Let me check. ".repeat(60)), 0);
        assert!(!g.tripped());
    }

    #[test]
    fn gate_delta_drops_the_loop_and_keeps_the_answer() {
        let mut g = guard();
        let mut forwarded = 0;
        let mut dropped = 0;
        for _ in 0..60 {
            match gate_delta(&mut g, StreamDelta::Think("Let me check. ".into())) {
                Some(_) => forwarded += 1,
                None => dropped += 1,
            }
        }
        assert!(g.tripped());
        assert!(dropped > 0, "the loop must stop reaching the host");
        assert!(forwarded > 0, "the opening of the block is still shown");

        // The answer itself is never gated, and it clears the trip.
        assert!(gate_delta(&mut g, StreamDelta::Text("Here is the fix.".into())).is_some());
        assert!(!g.tripped());
        assert!(gate_delta(&mut g, StreamDelta::Think("A fresh block.".into())).is_some());
    }
}
