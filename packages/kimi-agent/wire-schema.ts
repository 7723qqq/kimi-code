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