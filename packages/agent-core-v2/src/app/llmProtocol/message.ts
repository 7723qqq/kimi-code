/**
 * `llmProtocol.message` — v2's public wire type surface for LLM message parts.
 *
 * Owns the type names `Role | ContentPart | TextPart | ThinkPart | ImageURLPart |
 * AudioURLPart | VideoURLPart | ToolCall | ToolCallPart | StreamedMessagePart |
 * Message` at the v2 boundary. Downstream v2 code and its consumers import these
 * from here, not from `@moonshot-ai/kosong`, so kosong stays an implementation
 * detail. Currently a pure re-export of kosong so field shapes stay bit-identical
 * — Phase 8 (native adapters) will replace the implementation without touching
 * this path.
 */

export type {
  AudioURLPart,
  ContentPart,
  ImageURLPart,
  Message,
  Role,
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ToolCall,
  ToolCallPart,
  VideoURLPart,
} from '@moonshot-ai/kosong';
