import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { ISessionProcessRunner } from '#/session/process/processRunner';

import { AcpBackend } from './acpBackend';
import { ClaudeCodeBackend } from './claudeCodeBackend';
import { CodexBackend } from './codexBackend';
import {
  ISubagentBackendService,
  type ISubagentBackend,
  type SubagentBackendName,
} from './subagentBackend';

export class SubagentBackendService extends Service implements ISubagentBackendService {
  declare readonly _serviceBrand: undefined;

  private readonly backends = new Map<SubagentBackendName, ISubagentBackend>();

  constructor(
    @ISessionProcessRunner processRunner: ISessionProcessRunner,
    @IConfigService config: IConfigService,
  ) {
    super();
    this.register(new ClaudeCodeBackend(config));
    this.register(new CodexBackend(processRunner, config));
    this.register(new AcpBackend(processRunner, config));
  }

  getBackend(name: SubagentBackendName): ISubagentBackend | undefined {
    return this.backends.get(name);
  }

  list(): readonly ISubagentBackend[] {
    return [...this.backends.values()];
  }

  private register(backend: ISubagentBackend): void {
    this.backends.set(backend.name, backend);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISubagentBackendService,
  SubagentBackendService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
