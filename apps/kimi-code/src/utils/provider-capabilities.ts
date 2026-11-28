export const PROVIDER_WIRE_TYPES = [
  'kimi',
  'openai',
  'openai_responses',
  'anthropic',
  'google-genai',
  'vertexai',
] as const;

export type ProviderWireType = (typeof PROVIDER_WIRE_TYPES)[number];

export const CAPABILITY_NAMES = [
  'image_in',
  'video_in',
  'audio_in',
  'pdf_in',
  'thinking',
  'always_thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export function isCapabilityName(value: string): value is CapabilityName {
  return (CAPABILITY_NAMES as readonly string[]).includes(value);
}

export const THINKING_EFFORT_NAMES = ['off', 'low', 'medium', 'high', 'max', 'xhigh'] as const;
