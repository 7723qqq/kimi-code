import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { LifecycleScope } from '#/app/scopes';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { lineFingerprint } from './renderedLines';

const MAX_TRACKED_LINES = 1024;

export interface IAgentMemoryInjectionState {
  readonly _serviceBrand: undefined;
  readonly generation: number;
  has(line: string): boolean;
  mark(lines: readonly string[]): void;
}

export const IAgentMemoryInjectionState = createDecorator<IAgentMemoryInjectionState>(
  'agentMemoryInjectionState',
);

export class AgentMemoryInjectionState extends Disposable implements IAgentMemoryInjectionState {
  declare readonly _serviceBrand: undefined;
  private readonly rendered = new Set<string>();
  private revision: number;
  private currentGeneration = 0;
  private disposed = false;

  constructor(
    @IAgentContextMemoryService private readonly contextMemory: IAgentContextMemoryService,
    @ISessionContext readonly session: ISessionContext,
    @IAgentScopeContext readonly agent: IAgentScopeContext,
  ) {
    super();
    this.revision = contextMemory.prefixRevision();
  }

  get generation(): number {
    this.syncRevision();
    return this.currentGeneration;
  }

  private syncRevision(): void {
    const revision = this.contextMemory.prefixRevision();
    if (revision !== this.revision) {
      this.rendered.clear();
      this.revision = revision;
      this.currentGeneration += 1;
    }
  }

  has(line: string): boolean {
    this.syncRevision();
    return this.rendered.has(lineFingerprint(line));
  }

  mark(lines: readonly string[]): void {
    this.syncRevision();
    if (this.disposed) return;
    for (const line of lines) {
      this.rendered.add(lineFingerprint(line));
      if (this.rendered.size <= MAX_TRACKED_LINES) continue;
      const oldest = this.rendered.values().next().value;
      if (oldest !== undefined) this.rendered.delete(oldest);
    }
  }

  override dispose(): void {
    this.disposed = true;
    this.rendered.clear();
    super.dispose();
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMemoryInjectionState,
  AgentMemoryInjectionState,
  ScopeActivation.OnScopeCreated,
  'memoryInjectionState',
);
