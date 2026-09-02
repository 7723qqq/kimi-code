// Zod mirrors of the Rust→JS wire payloads (`rpc/types.rs` + the napi
// callback registry). The napi boundary crosses these as JSON strings, so
// the compile-time check on `napi-contract.d.ts` does not cover them — these
// schemas are the runtime drift catcher: a Rust-side shape change fails here
// with a named payload instead of silently misbehaving downstream.
import { z } from 'zod';

const tokenUsage = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
  input_cache_read: z.number().optional(),
  input_cache_creation: z.number().optional(),
});

const toolDef = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.unknown(),
});

export const llmChatRequestSchema = z.object({
  system_prompt: z.string(),
  model_name: z.string(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.string(),
      blocks: z.array(z.unknown()).optional(),
    }),
  ),
  tools: z.array(toolDef),
  request_id: z.string().optional(),
});

export const toolExecuteRequestSchema = z.object({
  turn_id: z.string(),
  tool_call_id: z.string(),
  tool_name: z.string(),
  arguments: z.unknown(),
});

export const permissionCheckRequestSchema = z.object({
  tool_name: z.string(),
  tool_call_id: z.string(),
  arguments: z.unknown(),
});

// ── Rust→JS: turn lifecycle (`turn_events.rs`, `host/turn_event`) ──────────
// The three durable records drive the host's append log and turn-state fold,
// so a shape drift here corrupts the transcript rather than just a display.
// `input` and `origin` stay unvalidated on purpose: the engine echoes back
// whatever the host handed it, and v2 declares both as opaque custom types
// (`z.custom<ContentPart[]>` / `z.custom<PromptOrigin>`).
export const turnEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('turn.prompt'),
    turnId: z.number(),
    input: z.unknown(),
    origin: z.unknown(),
  }),
  z.object({
    type: z.literal('turn.started'),
    turnId: z.number(),
    origin: z.unknown(),
  }),
  z.object({
    type: z.literal('turn.cancel'),
    turnId: z.number().optional(),
    target: z.enum(['active', 'queued']).optional(),
    reason: z.enum(['user_cancelled', 'aborted']).optional(),
  }),
  z.object({
    type: z.literal('turn.ended'),
    turnId: z.number(),
    reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
    error: z.unknown().optional(),
    durationMs: z.number().optional(),
  }),
]);

export type TurnEventWire = z.infer<typeof turnEventSchema>;

// ── Rust→JS: turn telemetry (`run_turn_with_telemetry`, `host/telemetry`) ──
// Fire-and-forget lifecycle telemetry: the host forwards one track2 per
// event and suppresses its own turn telemetry for engine-driven turns.
// Field names mirror the v2 telemetry vocabulary (snake_case); `trace_id`
// is a known gap — the engine cannot capture the provider request id yet.
export const telemetryEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('turn_started'),
    turn_id: z.string(),
    mode: z.string(),
    provider_type: z.string(),
    protocol: z.string(),
    thinking_effort: z.string().optional(),
  }),
  z.object({
    event: z.literal('turn_ended'),
    turn_id: z.string(),
    mode: z.string(),
    provider_type: z.string(),
    protocol: z.string(),
    thinking_effort: z.string().optional(),
    reason: z.enum(['completed', 'cancelled', 'failed']),
    duration_ms: z.number(),
    steps: z.number().optional(),
  }),
  z.object({
    event: z.literal('turn_interrupted'),
    turn_id: z.string(),
    mode: z.string(),
    provider_type: z.string(),
    protocol: z.string(),
    thinking_effort: z.string().optional(),
    at_step: z.number().optional(),
    interrupt_reason: z.enum(['aborted', 'error']),
  }),
  // P54: per-native-execution tool telemetry (v2 `ToolCallEvent`).
  z.object({
    event: z.literal('tool_call'),
    turn_id: z.number(),
    tool_call_id: z.string(),
    tool_name: z.string(),
    outcome: z.enum(['success', 'error', 'cancelled']),
    duration_ms: z.number(),
    dup_type: z.enum(['normal', 'same_step', 'cross_step']),
    error_type: z.enum(['cancelled', 'error']).optional(),
    trace_id: z.string().optional(),
  }),
]);

export type TelemetryEventWire = z.infer<typeof telemetryEventSchema>;

export const runTurnResultSchema = z.object({
  stop_reason: z.string(),
  steps: z.number(),
  usage: tokenUsage,
  events_emitted: z.number().optional(),
  llm_retries: z.number().optional(),
  llm_transport: z.string().optional(),
  native_tool_calls: z.number().optional(),
});

// ── JS→Rust direction (stdio `agent/run_turn` request) ─────────────────────
// The Rust side deserializes with `serde(default)` on most fields, so a
// mistyped field name would silently fall back to the default instead of
// failing — validating the outgoing payload is the only drift catcher for
// this direction.

const goalContext = z.object({
  goal_id: z.string(),
  objective: z.string(),
  status: z.string(),
  token_budget: z.number().nullable().optional(),
  turn_budget: z.number().nullable().optional(),
  wall_clock_budget_ms: z.number().nullable().optional(),
  wall_clock_ms: z.number(),
  tokens_used: z.number(),
  turns_used: z.number(),
});

const nativeLlmConfig = z.object({
  protocol: z.string(),
  base_url: z.string(),
  api_key: z.string(),
  model: z.string(),
  max_tokens: z.number().optional(),
  custom_headers: z.record(z.string(), z.string()).optional(),
});

const policySnapshot = z.object({
  mode: z.enum(['manual', 'auto', 'yolo']).optional(),
  deny_rules: z.array(z.string()).optional(),
  ask_rules: z.array(z.string()).optional(),
  allow_rules: z.array(z.string()).optional(),
  session_approvals: z.array(z.string()).optional(),
  git_cwd: z.string().optional(),
});

const telemetryContext = z.object({
  mode: z.string(),
  provider_type: z.string(),
  protocol: z.string(),
  thinking_effort: z.string().nullish(),
});

export const runTurnParamsSchema = z.object({
  turn_id: z.string(),
  system_prompt: z.string(),
  model_name: z.string(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.string(),
      blocks: z.array(z.unknown()).optional(),
      tool_calls: z
        .array(z.object({ id: z.string(), name: z.string(), arguments: z.unknown() }))
        .optional(),
      tool_call_id: z.string().optional(),
    }),
  ),
  tools: z.array(toolDef),
  max_steps: z.number().optional(),
  max_context_tokens: z.number().optional(),
  providers: z
    .array(z.object({ name: z.string(), model: z.string(), system_prompt: z.string() }))
    .optional(),
  goal: goalContext.optional(),
  native_llm: nativeLlmConfig.optional(),
  workspace_root: z.string().optional(),
  native_tools: z.boolean().optional(),
  rust_self_contained: z.boolean().optional(),
  shell_path: z.string().optional(),
  policy_snapshot: policySnapshot.optional(),
  github_token: z.string().optional(),
  github_base_url: z.string().optional(),
  telemetry: telemetryContext.optional(),
  subagent_profiles: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        system_prompt: z.string().optional(),
        tools: z.array(z.string()).optional(),
        disallowed_tools: z.array(z.string()).optional(),
        prompt_prefix: z.string().optional(),
        summary_policy: z
          .object({
            min_chars: z.number(),
            continuation_prompt: z.string(),
            retries: z.number(),
          })
          .optional(),
      }),
    )
    .optional(),
  subagent_timeout_ms: z.number().optional(),
  /** P52 native-path vetoes: non-empty reason = the engine rejects the
   *  affected native executions with this text as the tool result. */
  agent_tool_veto: z.string().optional(),
  tools_veto: z.string().optional(),
});

// ── EngineSession handle over stdio (M1d 3b) ──────────────────────────────
// The stdio transport drives the same session surface as the napi addon.
// These mirror `SessionEnqueueParams` / `SessionIdParams` /
// `SessionTurnOutcomeParams` / `SessionCancelParams` / `SessionHistoryParams`
// / `SessionOutcomeResult` / `SessionStatusResult` in rpc/types.rs.

/** The wire `Message` shape (rpc/types.rs) — prompts and history entries. */
export const sessionMessageSchema = z.object({
  role: z.string(),
  content: z.string(),
  blocks: z.array(z.unknown()).optional(),
  tool_calls: z
    .array(z.object({ id: z.string(), name: z.string(), arguments: z.unknown() }))
    .optional(),
  tool_call_id: z.string().optional(),
});

export type SessionMessageWire = z.infer<typeof sessionMessageSchema>;

export const sessionEnqueueTurnParamsSchema = z.object({
  session_id: z.string(),
  prompt: sessionMessageSchema,
  admission: z.enum(['newTurn', 'activeOrNewTurn', 'activeOrNextTurn', 'activeTurnOnly']),
});

export const sessionIdParamsSchema = z.object({
  session_id: z.string(),
});

export const sessionTurnOutcomeParamsSchema = z.object({
  session_id: z.string(),
  turn_id: z.number(),
});

export const sessionCancelParamsSchema = z.object({
  session_id: z.string(),
  turn_id: z.number().optional(),
});

export const sessionHistoryParamsSchema = z.object({
  session_id: z.string(),
  history: z.array(sessionMessageSchema),
});

export const sessionStatusResultSchema = z.object({
  active_turn_id: z.number().nullable(),
  pending_turn_ids: z.array(z.number()),
  /** P56 (G-5): execution-path summary of the last completed turn. */
  engine: z
    .object({
      transport: z.string().nullable(),
      native_tool_calls: z.number().nullable(),
      steps: z.number().nullable(),
      stop_reason: z.string().nullable(),
    })
    .optional(),
});

export type SessionStatusWire = z.infer<typeof sessionStatusResultSchema>;

export const sessionTurnOutcomeResultSchema = z.object({
  status: z.enum(['ran', 'cancelledBeforeStart']),
  result: runTurnResultSchema.optional(),
});

export type SessionTurnOutcomeWire = z.infer<typeof sessionTurnOutcomeResultSchema>;
