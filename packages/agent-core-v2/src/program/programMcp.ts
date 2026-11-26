import type { IEnvironmentService } from '#/app/environment/environment';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IWorkspaceContext } from '#/project/projectContext/projectContext';
import type { IWorkspaceDirs } from '#/project/projectDirs/projectDirs';
import type { IWorkspaceMcpService } from '#/project/projectMcp/projectMcp';
import { WorkspaceMcpService } from '#/project/projectMcp/projectMcpService';
import { WorkspaceMcpConfigService } from '#/project/projectMcpConfig/projectMcpConfigService';
import type { IWorkspaceTrust } from '#/project/projectTrust/projectTrust';

import type { ProgramDependencies } from './programDependencies';

export interface ProgramMcpLease {
  readonly service: IWorkspaceMcpService;
  dispose(): void;
}

interface McpSet {
  readonly config: WorkspaceMcpConfigService;
  readonly service: WorkspaceMcpService;
  references: number;
}

export class ProgramMcp {
  private current?: McpSet;
  private closing?: Promise<void>;
  private disposed = false;

  constructor(
    private readonly environments: IEnvironmentService,
    private readonly context: IWorkspaceContext,
    private readonly dependencies: ProgramDependencies,
    private readonly hostFs: IHostFileSystem,
    private readonly dirs: IWorkspaceDirs,
    private readonly trust: IWorkspaceTrust,
  ) {}

  async acquire(): Promise<ProgramMcpLease> {
    while (this.closing !== undefined) await this.closing;
    await Promise.resolve();
    if (this.disposed) throw new Error('program MCP is disposed');
    const set = (this.current ??= this.open());
    set.references += 1;
    let released = false;
    return {
      service: set.service,
      dispose: () => {
        if (released) return;
        released = true;
        set.references -= 1;
        if (set.references === 0 && this.current === set) this.closing = this.close(set);
      },
    };
  }

  servers(): Readonly<Record<string, McpServerConfig>> {
    return (this.current ??= this.open()).config.servers();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.current !== undefined) this.closing = this.close(this.current);
    await this.closing;
  }

  private open(): McpSet {
    const { bootstrap, config, configStore, identity, log, oauth, plugins, sessionManager, telemetry } = this.dependencies;
    const mcpConfig = new WorkspaceMcpConfigService(
      this.dirs,
      bootstrap,
      plugins,
      log,
      config,
      this.hostFs,
      this.trust,
      configStore,
    );
    const service = new WorkspaceMcpService(
      this.context,
      this.dirs,
      this.environments,
      mcpConfig,
      oauth,
      log,
      telemetry,
      identity,
      sessionManager,
    );
    return { config: mcpConfig, service, references: 0 };
  }

  private async close(set: McpSet): Promise<void> {
    this.current = undefined;
    try {
      await set.service.disposeAsync().finally(() => {
        set.config.dispose();
      });
    } catch (error) {
      this.dependencies.log.error('program MCP disposal failed', {
        workspaceId: this.context.workspaceId,
        error,
      });
    } finally {
      this.closing = undefined;
    }
  }
}
