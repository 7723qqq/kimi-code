import { createHash, randomUUID } from 'node:crypto';

import { join } from 'pathe';

import { Service } from '#/_base/di/service';
import { generateHeroSlug } from '#/_base/utils/hero-slug';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { defaultPathClass } from '#/agent/permissionPolicy/policies/path-utils';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { BeforeToolExecuteEvent } from '#/agent/toolExecutor/toolHooks';
import { ContextUndone } from '#/agent/undo/undoService';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { Error2 } from '#/errors';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { isWithinDirectoryResolved } from '#/tool/path-access';
import type { ToolFileAccess } from '#/tool/toolContract';

import { SpecErrors } from './errors';
import { ExitSpecModeReview } from './exitSpecModeReview';
import { SpecModeInjection } from './injection/specModeInjection';
import {
  IAgentSpecService,
  SPEC_ALL_FILES,
  SPEC_DIR_NAME,
  SPEC_PROGRESS_FILE,
  SPEC_REQUIRED_FILES,
  type SpecData,
  type SpecStage,
} from './spec';
import { SpecModeCancel, SpecModeEnter, SpecModeExit, SpecRevision, specKey } from './specOps';

export class AgentSpecService extends Service implements IAgentSpecService {
  declare readonly _serviceBrand: undefined;

  private readonly review: ExitSpecModeReview;
  private readonly writeDenied: string;

  constructor(
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IBlobStore private readonly blobs: IBlobStore,
    @IEventBus eventBus: IEventBus,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentReminderService reminder: IAgentReminderService,
  ) {
    super();
    this.review = new ExitSpecModeReview(this, this.toolApproval, this.telemetry);
    this.agentState.contributeState(specKey);
    this.writeDenied =
      'Spec mode is active. You may only write inside the current spec directory. ' +
      'Call ExitSpecMode to exit spec mode before editing other files.';

    this._register(
      this.dispatcher.hooks.onDidRestore.register('spec', async (_ctx, next) => {
        this.restoreTelemetryMode();
        await next();
      }),
    );
    this._register(
      eventBus.subscribe(ContextUndone, () => {
        this.restoreTelemetryMode();
        void this.dispatcher.dispatch(
          new AgentStatusUpdated({ agentId: this.agentCtx.agentId, specMode: this.isActive }),
        );
      }),
    );
    this._register(toolExecutor.onBeforeExecuteTool((event) => this.guardToolExecution(event)));
    this._register(new SpecModeInjection(reminder, this, this.context, this.agentState));
  }

  private get isActive(): boolean {
    return this.agentState.get(specKey).active;
  }

  private restoreTelemetryMode(): void {
    this.telemetry.setContext({ mode: this.isActive ? 'spec' : 'agent' });
  }

  private createSpecId(): string {
    return generateHeroSlug(randomUUID(), new Set());
  }

  specDirPathFor(id: string): string {
    return join(this.workspaceCtx.workDir, SPEC_DIR_NAME, id);
  }

  activeSpecDir(): string | null {
    const state = this.agentState.get(specKey);
    if (!state.active || state.id === undefined) return null;
    return this.specDirPathFor(state.id);
  }

  async enter(id = this.createSpecId()): Promise<void> {
    if (this.isActive) {
      throw new Error2(SpecErrors.codes.SPEC_MODE_INVALID, 'Already in spec mode');
    }
    const dir = this.specDirPathFor(id);

    await this.hostFs.mkdir(dir, { recursive: true });
    await this.dispatcher.dispatch(new SpecModeEnter({ agentId: this.agentCtx.agentId, id }));

    try {
      this.telemetry.setContext({ mode: 'spec' });
    } catch (error) {
      this.cancel(id);
      throw error;
    }
  }

  cancel(id?: string): void {
    void this.dispatcher.dispatch(new SpecModeCancel({ agentId: this.agentCtx.agentId, id }));
    this.telemetry.setContext({ mode: 'agent' });
  }

  exit(id?: string): void {
    void this.dispatcher.dispatch(new SpecModeExit({ agentId: this.agentCtx.agentId, id }));
    this.telemetry.setContext({ mode: 'agent' });
  }

  async clear(): Promise<void> {
    const dir = this.activeSpecDir();
    if (dir === null) return;
    for (const name of SPEC_ALL_FILES) {
      try {
        await this.hostFs.remove(join(dir, name));
      } catch {

      }
    }
  }

  async recordRevision(data?: SpecData): Promise<void> {
    const state = this.agentState.get(specKey);
    if (!state.active || state.id === undefined) return;
    const id = state.id;
    const current = data ?? (await this.documentData(id));
    if (current === null) return;
    const parts: string[] = [];
    for (const name of SPEC_REQUIRED_FILES) {
      parts.push(`# ${name}\n\n${current.files[name] ?? ''}`);
    }
    const bytes = Buffer.from(parts.join('\n\n'), 'utf8');
    const version = (state.revisionCount?.[id] ?? 0) + 1;
    const key = `spec/${id}/v${version}.md`;
    await this.blobs.put(this.agentCtx.scope(), key, bytes);
    await this.dispatcher.dispatch(
      new SpecRevision({
        agentId: this.agentCtx.agentId,
        id,
        version,
        key,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.byteLength,
      }),
    );
  }

  async status(): Promise<SpecData | null> {
    const state = this.agentState.get(specKey);
    if (!state.active || state.id === undefined) return null;
    return this.documentData(state.id);
  }

  private async documentData(id: string): Promise<SpecData | null> {
    const state = this.agentState.get(specKey);
    if (!state.active || state.id !== id) return null;
    const dir = this.specDirPathFor(id);
    const files: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of SPEC_REQUIRED_FILES) {
      const content = await this.readSpecFile(dir, name);
      files[name] = content;
      if (content.trim().length === 0) missing.push(name);
    }

    const progress = await this.readSpecFile(dir, SPEC_PROGRESS_FILE);
    return {
      id,
      dir,
      files,
      progress,
      missing: missing as SpecData['missing'],
      complete: missing.length === 0,
      stage: stageFor(missing),
    };
  }

  private async readSpecFile(dir: string, name: string): Promise<string> {
    try {
      return await this.hostFs.readText(join(dir, name));
    } catch {
      return '';
    }
  }

  private guardToolExecution(event: BeforeToolExecuteEvent): void {
    const dir = this.activeSpecDir();
    if (dir === null) return;

    const toolName = event.toolCall.name;
    if (toolName === 'ExitSpecMode') {
      if (this.modeService.mode !== 'auto') {
        event.waitUntil(() => this.review.requestApproval(event));
      }
      return;
    }

    if (toolName === 'TaskStop' || toolName === 'CronCreate' || toolName === 'CronDelete') {
      event.veto(
        denyToolExecution(
          this.toolApproval.formatDenyMessage(
            `${toolName} is not available in spec mode because it would mutate work that outlives the spec. Call ExitSpecMode first.`,
          ),
        ),
      );
      return;
    }

    const accesses = event.execution.accesses ?? [];
    const unidentified = accesses.filter((access) => access.kind !== 'file');
    if (unidentified.length > 0) {

      event.veto(denyToolExecution(this.toolApproval.formatDenyMessage(this.writeDenied)));
      return;
    }

    const writes = accesses.filter(
      (access): access is ToolFileAccess =>
        access.kind === 'file' &&
        (access.operation === 'write' || access.operation === 'readwrite'),
    );
    if (writes.length === 0) return;

    event.waitUntil(async () => {
      for (const access of writes) {
        const contained = await isWithinDirectoryResolved(
          access.path,
          dir,
          this.hostFs,
          pathClassFor(),
        );
        if (contained !== true) {
          return { veto: denyToolExecution(this.toolApproval.formatDenyMessage(this.writeDenied)) };
        }
      }
      return { executionMetadata: undefined };
    });
  }
}

function pathClassFor(): ReturnType<typeof defaultPathClass> {
  return defaultPathClass();
}

function stageFor(missing: readonly string[]): SpecStage {
  if (missing.includes('requirements.md')) return 'specify';
  if (missing.includes('design.md')) return 'plan';
  if (missing.includes('tasks.md')) return 'tasks';
  return 'implement';
}
