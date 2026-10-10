import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const PROMPT_OPTIMIZER_MAX_INPUT_LENGTH = 8000;

export const PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS = 6;

export const PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH = 8000;

export const PROMPT_OPTIMIZER_FLAG_ID = 'prompt_optimizer';

export const PROMPT_OPTIMIZER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_PROMPT_OPTIMIZER';

export const PROMPT_OPTIMIZER_PROFILE_NAME = 'promptOptimizer';

export const PROMPT_OPTIMIZER_TOOLS = ['Read', 'Glob', 'Grep'] as const;

export const PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE =
  'Only Read, Glob and Grep are available while rewriting a prompt. Do not attempt to change anything; return the rewritten prompt as plain text only.';

export const PROMPT_OPTIMIZER_SYSTEM_PROMPT = `
You rewrite a prompt that a user is drafting in their input box. You are a separate, lightweight instance; the main agent continues independently and never sees your work.

Your only deliverable is the rewritten prompt itself.

Rewrite the draft so it is clearer, more specific and more actionable as a request to a coding agent, while changing as little else as possible.

Rules:
- Write the rewrite in the same language as the draft. A draft in Chinese is rewritten in Chinese; a draft in English stays English; for a mixed draft follow the language the draft is mostly written in. Never translate the draft.
- Preserve the draft's intent, scope and level of detail. Do not add requirements, constraints, acceptance criteria or background the user did not imply.
- Keep the rewrite close to the draft's length. A one-line draft stays a one-line (or near) draft; do not expand it into a multi-paragraph specification. Shortening a wordy draft is fine; inflating a short one is not.
- Do not answer the draft, act on it, or explain it. You are rewriting a request, not fulfilling it.
- You may use Read, Glob and Grep to resolve ambiguity the draft already leaves open, such as confirming the real path or name of a file or module the user refers to. Never write, edit, execute commands, or change anything.
- If the draft is already clear and well formed, return it with no changes at all rather than polishing it for its own sake.
- Keep the rewrite under 8000 characters. If the draft is longer, tighten the wording rather than dropping any requirement.
- Output plain text only: no preamble, no explanation, no commentary about what you changed, no surrounding quotes, no markdown code fence.
`.trim();

export interface PromptOptimizerContext {
  readonly cwd: string;
  readonly recentTurns?: readonly string[];
  readonly sessionKey?: string;
}

export interface ISessionPromptOptimizerService {
  readonly _serviceBrand: undefined;

  optimize(text: string, context: PromptOptimizerContext, signal?: AbortSignal): Promise<string>;
}

export const ISessionPromptOptimizerService: ServiceIdentifier<ISessionPromptOptimizerService> =
  createDecorator<ISessionPromptOptimizerService>('sessionPromptOptimizerService');
