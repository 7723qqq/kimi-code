import type { ModelCapability as LlmModelCapability } from '#human/llm/capability';

export interface ModelCapability {
  readonly image_in: boolean;
  readonly video_in: boolean;
  readonly audio_in: boolean;
  readonly thinking: boolean;
  readonly tool_use: boolean;
  readonly pdf_in?: boolean;
  readonly max_context_tokens: number;
  readonly max_input_tokens?: number;
  readonly dynamically_loaded_tools?: boolean;
}

const UNKNOWN_CAPABILITY_MARKER = Symbol.for('moonshot-ai.kosong.UNKNOWN_CAPABILITY');

export const UNKNOWN_CAPABILITY: ModelCapability = Object.freeze(
  Object.defineProperty(
    {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: false,
      pdf_in: false,
      max_context_tokens: 0,
      dynamically_loaded_tools: false,
    },
    UNKNOWN_CAPABILITY_MARKER,
    { value: true },
  ),
);

export function isUnknownCapability(capability: ModelCapability): boolean {
  if (capability === UNKNOWN_CAPABILITY) return true;
  const marked =
    (capability as unknown as Record<PropertyKey, unknown>)[UNKNOWN_CAPABILITY_MARKER] === true;
  if (marked) return true;
  return (
    !capability.image_in &&
    !capability.video_in &&
    !capability.audio_in &&
    !capability.thinking &&
    !capability.tool_use &&
    capability.pdf_in !== true &&
    capability.dynamically_loaded_tools !== true &&
    capability.max_context_tokens === 0
  );
}

export function markUnknownCapability(capability: ModelCapability): ModelCapability {
  return Object.defineProperty({ ...capability }, UNKNOWN_CAPABILITY_MARKER, { value: true });
}

export function toLlmCapability(capability: ModelCapability): LlmModelCapability {
  return {
    image_in: capability.image_in,
    video_in: capability.video_in,
    audio_in: capability.audio_in,
    thinking: capability.thinking,
    tool_use: capability.tool_use,
    pdf_in: capability.pdf_in,
    dynamically_loaded_tools: capability.dynamically_loaded_tools,
  };
}
