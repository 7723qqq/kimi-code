import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const PROMPT_OPTIMIZER_MAX_INPUT_LENGTH = 8000;

export const PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS = 6;

export const PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH = 4000;

export const PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH = 8000;

export const PROMPT_OPTIMIZER_FLAG_ID = 'prompt_optimizer';

export const PROMPT_OPTIMIZER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_PROMPT_OPTIMIZER';

export const PROMPT_OPTIMIZER_PROFILE_NAME = 'promptOptimizer';

export const PROMPT_OPTIMIZER_TOOLS = ['Read', 'Glob', 'Grep'] as const;

export const PROMPT_OPTIMIZER_TRUNCATION_MARKER = '…(truncated)';

export const PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE =
  'Only Read, Glob and Grep are available while rewriting a prompt. Do not attempt to change anything; return the rewritten prompt as plain text only.';

export const PROMPT_OPTIMIZER_SYSTEM_PROMPT = `
You rewrite a prompt that a user is drafting in their input box. You are a separate, lightweight instance; the main agent continues independently and never sees your work.

Your only deliverable is the rewritten prompt itself.

The user is writing a short draft and expects you to know what they mean by it. Write that request out in full — the same request the user has in mind, complete enough that the agent receiving it knows exactly what to do and what would count as done.

Reading the draft:
- The draft is a pointer, not the whole request. The recent conversation, the working directory and the files it names are what tell you which request the user means.
- Put the real name behind every vague reference — "那个 bug", "the module", "继续" — using what the conversation has already established.
- State what the user is clearly working from but has not written down: which part of the codebase this concerns, what has to change, and what they will check to call it finished.

Rules:
- Write in the draft's language. Never translate it.
- Every sentence must carry something the user meant. Ground each added detail in the conversation or the workspace, and do not invent requirements or background that nothing shows they have in mind. Where you genuinely cannot tell what they meant, leave that part as they wrote it rather than guessing.
- Getting longer is expected: a four-word draft can become a paragraph, because it now says what the four words pointed at. But restating a draft in grander or more formal wording adds nothing, and a rewrite that only does that has failed.
- Do not answer the draft, act on it, or explain it. You are writing the request out, not fulfilling it.
- You may use Read, Glob and Grep to confirm a path, file or symbol you are about to name. Never write, edit or execute anything.
- Output plain text only: no preamble, no explanation, no commentary about what you changed, no surrounding quotes, no markdown code fence. Keep the rewrite under 8000 characters.
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
