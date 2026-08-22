export interface GoogleGeminiModelDef {
  readonly id: string;
  readonly displayName: string;
  readonly contextLength: number;
  readonly supportsReasoning: boolean;
  readonly supportsImageIn: boolean;
  readonly supportsVideoIn: boolean;
  readonly supportsToolUse: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
}

export const GOOGLE_GEMINI_DEFAULT_MODELS: readonly GoogleGeminiModelDef[] = [
  {
    id: 'gemini-3.7-flash',
    displayName: 'Gemini 3.7 Flash',
    contextLength: 1_000_000,
    supportsReasoning: true,
    supportsImageIn: true,
    supportsVideoIn: true,
    supportsToolUse: true,
    supportEfforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'gemini-3.1-pro',
    displayName: 'Gemini 3.1 Pro',
    contextLength: 2_000_000,
    supportsReasoning: true,
    supportsImageIn: true,
    supportsVideoIn: true,
    supportsToolUse: true,
    supportEfforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'gemini-3.6-flash',
    displayName: 'Gemini 3.6 Flash',
    contextLength: 1_000_000,
    supportsReasoning: true,
    supportsImageIn: true,
    supportsVideoIn: true,
    supportsToolUse: true,
    supportEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    contextLength: 1_000_000,
    supportsReasoning: true,
    supportsImageIn: true,
    supportsVideoIn: true,
    supportsToolUse: true,
    supportEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'claude-sonnet-4.6',
    displayName: 'Claude Sonnet 4.6 (Thinking)',
    contextLength: 1_000_000,
    supportsReasoning: true,
    supportsImageIn: true,
    supportsVideoIn: false,
    supportsToolUse: true,
    supportEfforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'claude-opus-4.6',
    displayName: 'Claude Opus 4.6 (Thinking)',
    contextLength: 1_000_000,
    supportsReasoning: true,
    supportsImageIn: true,
    supportsVideoIn: false,
    supportsToolUse: true,
    supportEfforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'gpt-oss-120b',
    displayName: 'GPT-OSS 120B (Medium)',
    contextLength: 500_000,
    supportsReasoning: true,
    supportsImageIn: false,
    supportsVideoIn: false,
    supportsToolUse: true,
    supportEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    contextLength: 2_000_000,
    supportsReasoning: true,
    supportsImageIn: true,
    supportsVideoIn: true,
    supportsToolUse: true,
    supportEfforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    contextLength: 1_000_000,
    supportsReasoning: true,
    supportsImageIn: true,
    supportsVideoIn: true,
    supportsToolUse: true,
    supportEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
];

export const GOOGLE_GEMINI_PROVIDER_ID = 'google-gemini';
export const GOOGLE_GEMINI_DEFAULT_MODEL_ID = 'gemini-3.7-flash';
