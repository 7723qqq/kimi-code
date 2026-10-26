import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { createDeadlineAbortSignal } from '#/_base/utils/abort';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '#/session/subagent/subagent';

import {
  ISessionPromptOptimizerService,
  PROMPT_OPTIMIZER_AGENT_HELPER,
  PROMPT_OPTIMIZER_COMPRESS_INSTRUCTION,
  PROMPT_OPTIMIZER_DRAFT_CLOSE,
  PROMPT_OPTIMIZER_DRAFT_OPEN,
  PROMPT_OPTIMIZER_FLAG_ID,
  PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH,
  PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS,
  PROMPT_OPTIMIZER_MAX_CONTEXT_TURN_CHARS,
  PROMPT_OPTIMIZER_MAX_INPUT_LENGTH,
  PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH,
  PROMPT_OPTIMIZER_PROFILE_NAME,
  PROMPT_OPTIMIZER_TIMEOUT_MS,
  PROMPT_OPTIMIZER_TOOLS,
  PROMPT_OPTIMIZER_TRUNCATION_MARKER,
  PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE,
  type PromptOptimizerContext,
} from './promptOptimizer';

const OPTIMIZER_LABELS: Readonly<Record<string, string>> = { promptOptimizer: 'prompt-optimizer' };

export class SessionPromptOptimizerService implements ISessionPromptOptimizerService {
  declare readonly _serviceBrand: undefined;

  private readonly inFlight = new Set<string>();

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
  ) {}

  async optimize(
    text: string,
    context: PromptOptimizerContext,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.flags.enabled(PROMPT_OPTIMIZER_FLAG_ID)) {
      throw new Error2(
        ErrorCodes.PROMPT_OPTIMIZER_DISABLED,
        'The prompt optimizer is disabled. Turn on the prompt_optimizer experimental flag to use it.',
      );
    }
    const draft = text.trim();
    if (draft.length === 0) {
      throw new Error2(ErrorCodes.PROMPT_OPTIMIZER_EMPTY_DRAFT, 'There is no prompt to rewrite.');
    }
    if (draft.length > PROMPT_OPTIMIZER_MAX_INPUT_LENGTH) {
      throw new Error2(
        ErrorCodes.PROMPT_OPTIMIZER_INPUT_TOO_LONG,
        `The draft is ${String(draft.length)} characters, over the ${String(PROMPT_OPTIMIZER_MAX_INPUT_LENGTH)} limit. Shorten it and try again.`,
        { details: { length: draft.length, limit: PROMPT_OPTIMIZER_MAX_INPUT_LENGTH } },
      );
    }
    const key = context.sessionKey;
    if (key !== undefined) {
      if (this.inFlight.has(key)) {
        throw new Error2(
          ErrorCodes.PROMPT_OPTIMIZER_BUSY,
          'A prompt rewrite is already running for this session.',
        );
      }
      this.inFlight.add(key);
    }

    const controller = new AbortController();
    const unlink = linkSignals(signal, controller);
    const deadline = createDeadlineAbortSignal(
      controller.signal,
      context.timeoutMs ?? PROMPT_OPTIMIZER_TIMEOUT_MS,
    );
    let childContext: Awaited<ReturnType<IAgentLifecycleService['fork']>> | undefined;
    try {
      const main = this.agentLifecycle.handleOf(MAIN_AGENT_ID);
      if (main === undefined) {
        throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
      }
      const explicitTurns = normalizedTurns(context.recentTurns);
      childContext = await this.agentLifecycle.fork(
        main.accessor.get(IAgentScopeContext).agentContext,
        {
          labels: OPTIMIZER_LABELS,
          binding: { profile: PROMPT_OPTIMIZER_PROFILE_NAME },
          inheritedHistory:
            explicitTurns === undefined
              ? {
                  maxUserTurns: inheritedTurnLimit(context),
                  maxChars: PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH,
                }
              : { maxUserTurns: 0 },
        },
      );
      const child = this.agentLifecycle.handleOf(childContext.agentId);
      if (child === undefined) {
        throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Optimizer agent could not be created');
      }
      const reason =
        child.accessor
          .get(IAgentToolApprovalService)
          ?.formatDenyMessage(PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE) ??
        PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE;
      const allowedTools: ReadonlySet<string> = new Set(PROMPT_OPTIMIZER_TOOLS);
      child.accessor.get(IAgentToolExecutorService)?.onBeforeExecuteTool((event) => {
        if (allowedTools.has(event.toolCall.name)) return;
        event.veto(denyToolExecution(reason));
      });

      const agentContext = childContext;
      const runOnce = async (prompt: string): Promise<string> => {
        const run = await this.subagents.run(
          agentContext,
          { kind: 'prompt', prompt, helper: PROMPT_OPTIMIZER_AGENT_HELPER },
          { signal: deadline.signal },
        );
        const completion = await run.completion;
        return completion.summary.trim();
      };

      const prompt = buildOptimizerInput(draft, context, explicitTurns);
      let rewritten = await runOnce(prompt);
      if (rewritten.length === 0) {
        throw new Error2(ErrorCodes.PROMPT_OPTIMIZER_NO_OUTPUT, 'The optimizer returned no text.');
      }
      if (rewritten.length > PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH) {
        rewritten = await runOnce(`${prompt}\n\n${PROMPT_OPTIMIZER_COMPRESS_INSTRUCTION}`);
        if (rewritten.length === 0) {
          throw new Error2(
            ErrorCodes.PROMPT_OPTIMIZER_NO_OUTPUT,
            'The optimizer returned no text.',
          );
        }
        if (rewritten.length > PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH) {
          throw new Error2(
            ErrorCodes.PROMPT_OPTIMIZER_OUTPUT_TOO_LONG,
            `The rewrite is ${String(rewritten.length)} characters, over the ${String(PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH)} limit, after one retry. Shorten the draft.`,
            { details: { length: rewritten.length, limit: PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH } },
          );
        }
      }
      return rewritten;
    } catch (error) {
      if (deadline.timedOut()) {
        throw new Error2(
          ErrorCodes.PROMPT_OPTIMIZER_TIMEOUT,
          `The rewrite did not finish within ${String(context.timeoutMs ?? PROMPT_OPTIMIZER_TIMEOUT_MS)}ms.`,
          { details: { timeoutMs: context.timeoutMs ?? PROMPT_OPTIMIZER_TIMEOUT_MS }, cause: error },
        );
      }
      throw error;
    } finally {
      deadline.clear();
      unlink();
      if (key !== undefined) this.inFlight.delete(key);
      if (childContext !== undefined) {
        await this.agentLifecycle.remove(childContext).catch((error: unknown) => {
          this.log.warn('promptOptimizer: failed to remove the throwaway agent', {
            agentId: childContext?.agentId,
            error,
          });
        });
      }
    }
  }
}

function inheritedTurnLimit(context: PromptOptimizerContext): number {
  const requested = context.recentTurns?.length;
  if (requested === undefined) return PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS;
  return Math.max(0, Math.min(requested, PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS));
}

function normalizedTurns(
  turns: readonly string[] | undefined,
): readonly string[] | undefined {
  if (turns === undefined) return undefined;
  const kept = turns
    .map((turn) => turn.trim())
    .filter((turn) => turn.length > 0)
    .slice(-PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS)
    .map((turn) => clamp(turn, PROMPT_OPTIMIZER_MAX_CONTEXT_TURN_CHARS));
  return kept.length === 0 ? undefined : kept;
}

function buildOptimizerInput(
  draft: string,
  context: PromptOptimizerContext,
  turns: readonly string[] | undefined,
): string {
  const sections = [`Working directory: ${context.cwd}`];
  if (turns !== undefined) {
    const block = turns.map((turn) => `- ${turn}`).join('\n');
    sections.push(
      `Recent user turns, oldest first:\n${clamp(block, PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH)}`,
    );
  }
  sections.push(
    `${PROMPT_OPTIMIZER_DRAFT_OPEN}\n${fenceSafe(draft)}\n${PROMPT_OPTIMIZER_DRAFT_CLOSE}`,
  );
  return sections.join('\n\n');
}

function fenceSafe(draft: string): string {
  return draft
    .replaceAll(PROMPT_OPTIMIZER_DRAFT_CLOSE, '&lt;/draft&gt;')
    .replaceAll(PROMPT_OPTIMIZER_DRAFT_OPEN, '&lt;draft&gt;');
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}${PROMPT_OPTIMIZER_TRUNCATION_MARKER}`;
}

function linkSignals(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (external === undefined) return () => {};
  if (external.aborted) {
    controller.abort(external.reason);
    return () => {};
  }
  const onAbort = (): void => {
    controller.abort(external.reason);
  };
  external.addEventListener('abort', onAbort, { once: true });
  return () => {
    external.removeEventListener('abort', onAbort);
  };
}

registerScopedService(
  LifecycleScope.Session,
  ISessionPromptOptimizerService,
  SessionPromptOptimizerService,
  ScopeActivation.OnScopeCreated,
  'promptOptimizer',
);
