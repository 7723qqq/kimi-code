import { IFlagService } from '#/app/flag/flag';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '#/session/subagent/subagent';

import {
  ISessionPromptOptimizerService,
  PROMPT_OPTIMIZER_FLAG_ID,
  PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH,
  PROMPT_OPTIMIZER_MAX_INPUT_LENGTH,
  PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH,
  PROMPT_OPTIMIZER_SYSTEM_REMINDER,
  PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE,
  type PromptOptimizerContext,
} from './promptOptimizer';

const OPTIMIZER_LABELS: Readonly<Record<string, string>> = { promptOptimizer: 'prompt-optimizer' };

export class SessionPromptOptimizerService implements ISessionPromptOptimizerService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @IFlagService private readonly flags: IFlagService,
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
        child.accessor.get(IAgentToolApprovalService)?.formatDenyMessage(
          PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE,
        ) ?? PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE;
      child.accessor
        .get(IAgentToolExecutorService)
        ?.onBeforeExecuteTool((event) => {
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
      return rewritten.slice(0, PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH);
    } finally {
      unlink();
      if (childContext !== undefined) {
        await this.agentLifecycle.remove(childContext).catch(() => {});
      }
    }
  }
}

function buildOptimizerInput(draft: string, context: PromptOptimizerContext): string {
  const sections = [`Working directory: ${context.cwd}`];
  const recent = context.recentTurns?.trim() ?? '';
  if (recent.length > 0) {
    sections.push(`Recent conversation:\n${recent.slice(0, PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH)}`);
  }
  sections.push(`Prompt to rewrite:\n${draft.slice(0, PROMPT_OPTIMIZER_MAX_INPUT_LENGTH)}`);
  return sections.join('\n\n');
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
