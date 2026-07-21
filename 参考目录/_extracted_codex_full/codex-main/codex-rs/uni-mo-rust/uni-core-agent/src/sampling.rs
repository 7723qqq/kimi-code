//! Sampling request execution and stream processing.
//!
//! Handles the core model invocation loop: streaming responses from the model,
//! parsing assistant text deltas, managing plan-mode state, executing tool
//! calls, and draining in-flight tool futures.
//!
//! Ported from codex-rs core/src/session/turn.rs `try_run_sampling_request`.

use crate::stream::{StreamEvent, TokenUsage};
use crate::types::{
    AgentError, AgentEvent, AgentResult, AgentSession, ContentItem, MessagePhase,
    Prompt, ResponseItem, SamplingRequestResult, TurnContext,
};
use futures::future::BoxFuture;
use futures::prelude::*;
use futures::stream::FuturesOrdered;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tracing::{error, field, info, instrument, trace, trace_span, warn};

