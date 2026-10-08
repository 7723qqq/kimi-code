import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '#/session/subagent/subagent';

import {
  ISessionPromptOptimizerService,
  PROMPT_OPTIMIZER_FLAG_ID,
  PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH,
  PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS,
  PROMPT_OPTIMIZER_MAX_INPUT_LENGTH,
  PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH,
  PROMPT_OPTIMIZER_SYSTEM_REMINDER,
  PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE,
  PROMPT_OPTIMIZER_TRUNCATION_MARKER,
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
    const key = context.sessionKey ?? '';
    if (this.inFlight.has(key)) {
      throw new Error2(
        ErrorCodes.PROMPT_OPTIMIZER_BUSY,
        'A prompt rewrite is already running for this session.',
      );
    }
    this.inFlight.add(key);

    const controller = new AbortController();
    const unlink = linkSignals(signal, controller);
    let childContext: Awaited<ReturnType<IAgentLifecycleService['fork']>> | undefined;
    try {
      const main = this.agentLifecycle.handleOf(MAIN_AGENT_ID);
      if (main === undefined) {
        throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
      }
      childContext = await this.agentLifecycle.fork(
        main.accessor.get(IAgentScopeContext).agentContext,
        { labels: OPTIMIZER_LABELS },
      );
      const child = this.agentLifecycle.handleOf(childContext.agentId);
      if (child === undefined) {
        throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Optimizer agent could not be created');
      }
      child.accessor
        .get(IAgentReminderService)
        .notify(PROMPT_OPTIMIZER_SYSTEM_REMINDER, { variant: 'prompt_optimizer' });
      const reason =
        child.accessor
          .get(IAgentToolApprovalService)
          ?.formatDenyMessage(PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE) ??
        PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE;
      child.accessor.get(IAgentToolExecutorService)?.onBeforeExecuteTool((event) => {
        event.veto(denyToolExecution(reason));
      });

      const run = await this.subagents.run(
        childContext,
        { kind: 'prompt', prompt: buildOptimizerInput(draft, context) },
        { signal: controller.signal },
      );
      const completion = await run.completion;
      const rewritten = completion.summary.trim();
      if (rewritten.length === 0) {
        throw new Error2(ErrorCodes.PROMPT_OPTIMIZER_NO_OUTPUT, 'The optimizer returned no text.');
      }
      return clampOutput(rewritten);
    } finally {
      unlink();
      this.inFlight.delete(key);
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

function clampOutput(text: string): string {
  if (text.length <= PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH) return text;
  const head = text.slice(0, PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH);
  const boundary = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('. '), head.lastIndexOf('。'));
  return boundary > 0 ? head.slice(0, boundary + 1) : head;
}

function buildOptimizerInput(draft: string, context: PromptOptimizerContext): string {
  const sections = [`Working directory: ${context.cwd}`];
  const recent = formatRecentTurns(context.recentTurns);
  if (recent.length > 0) {
    sections.push(`Recent conversation:\n${clamp(recent, PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH)}`);
  }
  sections.push(`Prompt to rewrite:\n${clamp(draft, PROMPT_OPTIMIZER_MAX_INPUT_LENGTH)}`);
  return sections.join('\n\n');
}

function formatRecentTurns(turns: readonly string[] | undefined): string {
  if (turns === undefined || turns.length === 0) return '';
  return turns
    .slice(-PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS)
    .map((turn) => turn.trim())
    .filter((turn) => turn.length > 0)
    .join('\n');
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
