import { Service } from '#/_base/di/service';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  HelloWorldModeEnter,
  HelloWorldModeExit,
  HelloWorldRunUpdated,
  helloWorldKey,
  helloWorldRunKey,
} from '../helloWorldOps';
import { HelloWorldInjection } from './injection/helloWorldInjection';
import {
  HELLO_WORLD_STAGES,
  type IAgentHelloWorldService,
  type HelloWorldModeTrigger,
  type HelloWorldRunItem,
  type HelloWorldRunItemId,
  type HelloWorldRunState,
  type HelloWorldStage,
} from './helloWorld';

interface ToolSignal {
  readonly kind: 'write' | 'command';
  readonly value: string;
}

interface EvidenceRule {
  readonly match: (signal: ToolSignal) => boolean;
  readonly from: readonly HelloWorldStage[];
  readonly to: HelloWorldStage;
  readonly items: readonly HelloWorldRunItemId[];
}

const SPECS_REQUIREMENTS_PATH = /(^|\/)specs\/[^/]+\/requirements\.md$/;
const SPECS_PLAN_PATH = /(^|\/)specs\/[^/]+\/(design|tasks)\.md$/;
const SPECS_TREE = /(^|\/)specs\//;
const DOCS_PATH = /(^|\/)docs\/|(^|\/)README[^/]*$/;
const CHANGESET_PATH = /(^|\/)\.changeset\/[^/]+\.md$/;
const CHECK_COMMAND = /\bbun\b.*\b(?:test|lint|typecheck|check:)/;

const EVIDENCE_RULES: readonly EvidenceRule[] = [
  {
    match: (signal) => signal.kind === 'write' && SPECS_REQUIREMENTS_PATH.test(signal.value),
    from: ['requirements'],
    to: 'design',
    items: ['requirements-approved'],
  },
  {
    match: (signal) => signal.kind === 'write' && SPECS_PLAN_PATH.test(signal.value),
    from: ['design'],
    to: 'implement',
    items: ['design-written', 'tasks-complete'],
  },
  {
    match: (signal) => signal.kind === 'write' && isCodeWritePath(signal.value),
    from: ['requirements', 'design'],
    to: 'implement',
    items: [],
  },
  {
    match: (signal) => signal.kind === 'command' && CHECK_COMMAND.test(signal.value),
    from: ['implement'],
    to: 'test',
    items: [],
  },
  {
    match: (signal) => signal.kind === 'command' && CHECK_COMMAND.test(signal.value),
    from: ['test'],
    to: 'review',
    items: ['tests-green'],
  },
  {
    match: (signal) => signal.kind === 'write' && DOCS_PATH.test(signal.value),
    from: ['review'],
    to: 'docs',
    items: ['review-done'],
  },
  {
    match: (signal) => signal.kind === 'write' && CHANGESET_PATH.test(signal.value),
    from: ['docs'],
    to: 'deliver',
    items: ['docs-updated', 'changeset-ready'],
  },
];

export class AgentHelloWorldService extends Service implements IAgentHelloWorldService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentReminderService reminder: IAgentReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this.agentState.contributeState(helloWorldKey);
    this.agentState.contributeState(helloWorldRunKey);
    this._register(
      new HelloWorldInjection(
        {
          getTrigger: () => this.agentState.get(helloWorldKey),
          getRun: () => this.agentState.get(helloWorldRunKey),
        },
        reminder,
        this.context,
      ),
    );
    this._register(
      toolExecutor.hooks.onDidExecuteTool.register('hello-world-run', async (ctx, next) => {
        this.observeToolRound(ctx);
        await next(ctx);
      }),
    );
  }

  enter(trigger: HelloWorldModeTrigger, task?: string): void {
    if (this.agentState.get(helloWorldKey) !== null) return;
    void this.dispatcher.dispatch(
      new HelloWorldModeEnter({ agentId: this.agentCtx.agentId, trigger, task }),
    );
    this.telemetry.track2('hello_world_mode_entered', { trigger });
  }

  exit(): void {
    const trigger = this.agentState.get(helloWorldKey);
    if (trigger === null) return;
    const history = this.context.get();
    void this.dispatcher.dispatch(new HelloWorldModeExit({ agentId: this.agentCtx.agentId }));
    this.telemetry.track2('hello_world_mode_exited', { trigger });
    this.context.publishTrailingRemoval(history);
  }

  advance(stage: HelloWorldStage | 'next'): void {
    const run = this.agentState.get(helloWorldRunKey);
    if (run === null) return;
    const target = stage === 'next' ? nextHelloWorldStage(run.stage) : stage;
    if (target === undefined) return;
    if (HELLO_WORLD_STAGES.indexOf(target) <= HELLO_WORLD_STAGES.indexOf(run.stage)) return;
    this.commitRun({ ...run, stage: target }, run.stage);
  }

  waive(item: HelloWorldRunItemId): void {
    const run = this.agentState.get(helloWorldRunKey);
    if (run === null) return;
    if (run.waivers.includes(item)) return;
    this.commitRun(
      {
        ...run,
        items: run.items.map((entry) => (entry.id === item ? markWaived(entry) : entry)),
        waivers: [...run.waivers, item],
      },
      run.stage,
    );
  }

  get isActive(): boolean {
    return this.agentState.get(helloWorldKey) !== null;
  }

  get run(): HelloWorldRunState | null {
    return this.agentState.get(helloWorldRunKey);
  }

  private observeToolRound(ctx: ToolDidExecuteContext): void {
    const run = this.agentState.get(helloWorldRunKey);
    if (run === null) return;
    const signal = toolSignalFromContext(ctx);
    if (signal === undefined) return;
    const rule = EVIDENCE_RULES.find(
      (entry) => entry.from.includes(run.stage) && entry.match(signal),
    );
    if (rule === undefined) return;
    this.commitRun(applyEvidence(run, rule, signal.value), run.stage);
  }

  private commitRun(run: HelloWorldRunState, previousStage: HelloWorldStage): void {
    void this.dispatcher.dispatch(
      new HelloWorldRunUpdated({
        agentId: this.agentCtx.agentId,
        stage: run.stage,
        task: run.task,
        items: run.items,
        waivers: run.waivers,
      }),
    );
    if (run.stage !== previousStage) {
      const stage: string = run.stage;
      const previous: string = previousStage;
      this.telemetry.track2('hello_world_stage_changed', { stage, previous });
    }
  }
}

function nextHelloWorldStage(stage: HelloWorldStage): HelloWorldStage | undefined {
  return HELLO_WORLD_STAGES[HELLO_WORLD_STAGES.indexOf(stage) + 1];
}

function markWaived(entry: HelloWorldRunItem): HelloWorldRunItem {
  return { id: entry.id, done: true, evidence: 'waived' };
}

function applyEvidence(
  run: HelloWorldRunState,
  rule: EvidenceRule,
  evidence: string,
): HelloWorldRunState {
  return {
    ...run,
    stage: rule.to,
    items: run.items.map((item) =>
      rule.items.includes(item.id) && !item.done ? { id: item.id, done: true, evidence } : item,
    ),
  };
}

function toolSignalFromContext(ctx: ToolDidExecuteContext): ToolSignal | undefined {
  if (ctx.outcome !== 'executed' || ctx.result.isError === true) return undefined;
  const args = ctx.args as Record<string, unknown> | undefined;
  if (ctx.toolCall.name === 'Write' || ctx.toolCall.name === 'Edit') {
    const path = stringField(args, 'path');
    return path === undefined ? undefined : { kind: 'write', value: normalizePath(path) };
  }
  if (ctx.toolCall.name === 'Bash') {
    const command = stringField(args, 'command');
    return command === undefined ? undefined : { kind: 'command', value: command };
  }
  return undefined;
}

function stringField(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizePath(path: string): string {
  return path.split('\\').join('/');
}

function isCodeWritePath(path: string): boolean {
  return (
    SPECS_TREE.test(path) === false &&
    DOCS_PATH.test(path) === false &&
    CHANGESET_PATH.test(path) === false
  );
}
