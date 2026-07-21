//! Auto-compaction logic for the agent turn loop.
//!
//! Manages token budget checks and triggers context compaction when the
//! conversation history exceeds the model's token limits.

use crate::types::{
    AgentError, AgentResult, AgentSession, AutoCompactTokenStatus,
    AutoCompactWindowSnapshot, CompactionPhase, CompactionReason,
    InitialContextInjection, TurnContext,
};
use std::sync::Arc;
use tracing::{instrument, trace, warn};

/// Computes the auto-compaction token status for the current turn.
///
/// Returns a struct indicating whether the token limit has been reached
/// and how full the context window is.
#[instrument(level = "trace", skip_all)]
pub async fn auto_compact_token_status(
    sess: &Arc<dyn AgentSession>,
    turn_context: &TurnContext,
) -> AutoCompactTokenStatus {
    let active_context_tokens = sess.get_total_token_usage().await;
    let mut auto_compact_window_prefill_tokens = None;

    let (auto_compact_scope_tokens, auto_compact_scope_limit, full_context_window_limit) =
        match turn_context.auto_compact_token_limit_scope {
            crate::types::AutoCompactTokenLimitScope::Total => (
                active_context_tokens,
                turn_context
                    .auto_compact_token_limit
                    .unwrap_or(i64::MAX),
                None,
            ),
            crate::types::AutoCompactTokenLimitScope::BodyAfterPrefix => {
                let window = sess.auto_compact_window_snapshot().await;
                auto_compact_window_prefill_tokens = window.prefill_input_tokens;
                let baseline = window
                    .prefill_input_tokens
                    .unwrap_or(active_context_tokens);
                (
                    active_context_tokens.saturating_sub(baseline),
                    turn_context
                        .auto_compact_token_limit
                        .unwrap_or(i64::MAX),
                    turn_context.model_info.resolved_context_window(),
                )
            }
        };

    let full_context_window_limit_reached = full_context_window_limit.is_some_and(|limit| {
        active_context_tokens >= limit
    });

    let token_limit_reached =
        auto_compact_scope_tokens >= auto_compact_scope_limit
            || full_context_window_limit_reached;

    AutoCompactTokenStatus {
        active_context_tokens,
        auto_compact_scope_tokens,
        auto_compact_scope_limit,
        full_context_window_limit,
        auto_compact_window_prefill_tokens,
        full_context_window_limit_reached,
        token_limit_reached,
    }
}

/// Runs pre-sampling compaction: checks if compaction is needed before
/// the model is invoked, and executes it if so.
#[instrument(level = "trace", skip_all)]
pub async fn run_pre_sampling_compact(
    sess: &Arc<dyn AgentSession>,
    turn_context: &TurnContext,
) -> AgentResult<()> {
    maybe_run_previous_model_inline_compact(sess, turn_context).await?;

    let token_status = auto_compact_token_status(sess, turn_context).await;

    if token_status.token_limit_reached {
        sess.run_auto_compact(
            turn_context,
            InitialContextInjection::DoNotInject,
            CompactionReason::ContextLimit,
            CompactionPhase::PreTurn,
        )
        .await?;
    }
    Ok(())
}

/// Returns true if the compaction compatibility hashes differ between turns.
fn comp_hash_changed(previous: Option<&str>, current: Option<&str>) -> bool {
    previous
        .zip(current)
        .is_some_and(|(p, c)| p != c)
}

/// Runs pre-sampling compaction against the previous model when the
/// compaction compatibility hash changed or when switching to a smaller
/// context-window model.
#[instrument(level = "trace", skip_all)]
pub async fn maybe_run_previous_model_inline_compact(
    sess: &Arc<dyn AgentSession>,
    turn_context: &TurnContext,
) -> AgentResult<()> {
    let Some(previous_settings) = sess.previous_turn_settings().await else {
        return Ok(());
    };

    let should_compact_for_comp_hash_change = comp_hash_changed(
        previous_settings.comp_hash.as_deref(),
        turn_context.comp_hash.as_deref(),
    );

    if should_compact_for_comp_hash_change {
        sess.run_auto_compact(
            turn_context,
            InitialContextInjection::DoNotInject,
            CompactionReason::CompHashChanged,
            CompactionPhase::PreTurn,
        )
        .await?;
        return Ok(());
    }

    let Some(old_context_window) =
        turn_context.model_info.resolved_context_window()
    else {
        return Ok(());
    };

    let _active_tokens = sess.get_total_token_usage().await;
    let _context_window_reached = _active_tokens >= old_context_window;

    if _context_window_reached {
        warn!(
            turn_id = %turn_context.sub_id,
            active_tokens = _active_tokens,
            context_window = old_context_window,
            "previous model context window reached; running compaction"
        );
        sess.run_auto_compact(
            turn_context,
            InitialContextInjection::DoNotInject,
            CompactionReason::ModelDownshift,
            CompactionPhase::PreTurn,
        )
        .await?;
    }

    Ok(())
}

/// Runs mid-turn auto-compaction when the token limit is reached.
#[instrument(level = "trace", skip_all, fields(reason = ?reason, phase = ?phase))]
pub async fn run_auto_compact(
    sess: &Arc<dyn AgentSession>,
    turn_context: &TurnContext,
    initial_context_injection: InitialContextInjection,
    reason: CompactionReason,
    phase: CompactionPhase,
) -> AgentResult<()> {
    trace!(
        turn_id = %turn_context.sub_id,
        ?reason,
        ?phase,
        ?initial_context_injection,
        "running auto-compaction"
    );

    sess.run_auto_compact(
        turn_context,
        initial_context_injection,
        reason,
        phase,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_comp_hash_changed_both_none() {
        assert!(!comp_hash_changed(None, None));
    }

    #[test]
    fn test_comp_hash_changed_one_none() {
        assert!(!comp_hash_changed(Some("abc"), None));
        assert!(!comp_hash_changed(None, Some("abc")));
    }

    #[test]
    fn test_comp_hash_changed_same() {
        assert!(!comp_hash_changed(Some("abc"), Some("abc")));
    }

    #[test]
    fn test_comp_hash_changed_different() {
        assert!(comp_hash_changed(Some("abc"), Some("def")));
    }
}
