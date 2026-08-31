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

export const toolFinalizeRequestSchema = z.object({
  tool_name: z.string(),
  tool_call_id: z.string(),
  content: z.string(),
  is_error: z.boolean(),
  note: z.string().optional(),
});

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
});

const policySnapshot = z.object({
  mode: z.enum(['manual', 'auto', 'yolo']).optional(),
  deny_rules: z.array(z.string()).optional(),
  ask_rules: z.array(z.string()).optional(),
  allow_rules: z.array(z.string()).optional(),
  session_approvals: z.array(z.string()).optional(),
  git_cwd: z.string().optional(),
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
});