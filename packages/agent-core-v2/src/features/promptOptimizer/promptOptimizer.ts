import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const PROMPT_OPTIMIZER_MAX_INPUT_LENGTH = 8000;

export const PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH = 4000;

export const PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS = 6;

export const PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH = 8000;

export const PROMPT_OPTIMIZER_FLAG_ID = 'prompt_optimizer';

export const PROMPT_OPTIMIZER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_PROMPT_OPTIMIZER';

export const PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE =
  'Tool calls are disabled while rewriting the user prompt. Return the rewritten prompt as plain text only.';

export const PROMPT_OPTIMIZER_SYSTEM_REMINDER = `
The user has asked you to rewrite a prompt they are drafting in their input box.

You are a separate, lightweight instance. The main agent continues independently.

Rules:
- Rewrite the draft into a clearer, more specific, and more actionable prompt for a coding agent.
- Preserve the user's original intent, scope, and language. Never answer the draft, never act on it, and never add requirements the user did not imply.
- Use the conversation context and working directory only to resolve ambiguity the draft already leaves open (for example naming a file or module the user clearly means).
- Output the rewritten prompt as plain text only. No preamble, no explanation, no surrounding quotes, no markdown code fence.
- If the draft is already clear, return it essentially unchanged rather than padding it.
`.trim();

export interface PromptOptimizerContext {
  readonly cwd: string;
  readonly recentTurns?: string;
}

export interface ISessionPromptOptimizerService {
  readonly _serviceBrand: undefined;

  optimize(text: string, context: PromptOptimizerContext, signal?: AbortSignal): Promise<string>;
}

export const ISessionPromptOptimizerService: ServiceIdentifier<ISessionPromptOptimizerService> =
  createDecorator<ISessionPromptOptimizerService>('sessionPromptOptimizerService');
