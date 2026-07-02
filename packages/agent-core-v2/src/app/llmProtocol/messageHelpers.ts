/**
 * `llmProtocol.messageHelpers` — runtime helpers for building and inspecting
 * wire messages / content parts / tool calls.
 *
 * Constructors: `createAssistantMessage | createToolMessage | createUserMessage`.
 * Predicates: `isContentPart | isToolCall | isToolCallPart`.
 * Utilities: `extractText | mergeInPlace` (in-place merge of streamed
 * tool-call argument deltas).
 *
 * Values are delegated to the vendored kosong copy under `./kosong` so behavior
 * is identical across the migration. Import from here rather than from the
 * vendored copy directly.
 */

export {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  extractText,
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
} from './kosong';
