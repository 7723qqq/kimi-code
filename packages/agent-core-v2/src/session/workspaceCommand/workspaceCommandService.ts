/**
 * `workspaceCommand` domain (L6) — `ISessionWorkspaceCommandService` implementation.
 *
 * Coordinates session-level workspace mutations. `addAdditionalDir` persists
 * the directory into the workspace-local config file when `persist` is true
 * (`<projectRoot>/.kimi-code/local.toml`, through `IHostFileSystem`), updates
 * `ISessionWorkspaceContext`, and mirrors the action's stdout into the main
 * agent's context as a `local-command-stdout` injection (via
 * `IAgentContextMemoryService` on the `main` handle from `agentLifecycle`).
 * If the main agent does not exist yet, the injection is queued and flushed
 * from the `onDidCreateMain` subscription. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService, type ContextMessage } from '#/agent/contextMemory';
import { IBootstrapService } from '#/app/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';

import {
  type AddAdditionalDirInput,
  ISessionWorkspaceCommandService,
  type WorkspaceAdditionalDirsResult,
} from './workspaceCommand';
import {
  appendWorkspaceAdditionalDir,
  normalizeAdditionalDirs,
  readWorkspaceAdditionalDirs,
  resolveWorkspaceAdditionalDirs,
  type WorkspaceLocalDeps,
} from './workspaceLocalConfig';

export class SessionWorkspaceCommandService
  extends Disposable
  implements ISessionWorkspaceCommandService
{
  declare readonly _serviceBrand: undefined;
  private readonly pendingMainInjections: ContextMessage[] = [];
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
  ) {
    super();
    this._register(
      this.agents.onDidCreateMain((handle) => {
        if (this.pendingMainInjections.length === 0) return;
        const pending = this.pendingMainInjections.splice(0);
        handle.accessor.get(IAgentContextMemoryService).append(...pending);
      }),
    );
  }

  async addAdditionalDir(input: AddAdditionalDirInput): Promise<WorkspaceAdditionalDirsResult> {
    return this.enqueueMutation(() => this.applyAddAdditionalDir(input));
  }

  private async applyAddAdditionalDir(
    input: AddAdditionalDirInput,
  ): Promise<WorkspaceAdditionalDirsResult> {
    const persist = input.persist ?? true;
    const deps: WorkspaceLocalDeps = { fs: this.hostFs, homeDir: this.bootstrap.homeDir };

    if (persist) {
      const persisted = await appendWorkspaceAdditionalDir(
        deps,
        this.workspace.workDir,
        input.path,
      );
      const additionalDirs = normalizeAdditionalDirs([
        ...this.workspace.additionalDirs,
        ...persisted.additionalDirs,
      ]);
      this.workspace.setAdditionalDirs(additionalDirs);
      this.injectAdditionalDirAdded(input.path, true, persisted.configPath);
      return {
        projectRoot: persisted.projectRoot,
        configPath: persisted.configPath,
        additionalDirs,
        persisted: true,
      };
    }

    const workspace = await readWorkspaceAdditionalDirs(deps, this.workspace.workDir);
    const resolved = await resolveWorkspaceAdditionalDirs(deps, this.workspace.workDir, [
      input.path,
    ]);
    const additionalDirs = normalizeAdditionalDirs([...this.workspace.additionalDirs, ...resolved]);
    this.workspace.setAdditionalDirs(additionalDirs);
    this.injectAdditionalDirAdded(input.path, false, workspace.configPath);
    return {
      projectRoot: workspace.projectRoot,
      configPath: workspace.configPath,
      additionalDirs,
      persisted: false,
    };
  }

  private enqueueMutation<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(work, work);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private injectAdditionalDirAdded(path: string, persisted: boolean, configPath: string): void {
    const stdout = persisted
      ? `Added workspace directory:\n  ${path}\n  Saved to:\n  ${configPath}`
      : `Added workspace directory:\n  ${path}\n  For this session only`;
    const text = `<local-command-stdout>\n${stdout.trim()}\n</local-command-stdout>`;
    const message: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'local-command-stdout' },
    };

    const main = this.agents.getHandle(MAIN_AGENT_ID);
    if (main !== undefined) {
      main.accessor.get(IAgentContextMemoryService).append(message);
      return;
    }
    this.pendingMainInjections.push(message);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionWorkspaceCommandService,
  SessionWorkspaceCommandService,
  InstantiationType.Delayed,
  'workspaceCommand',
);
