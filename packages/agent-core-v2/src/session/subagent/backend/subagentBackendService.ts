/**
 * `subagent` domain — `ISubagentBackendService` implementation.
 *
 * Owns the external subagent backends for the current session: constructs
 * the claude-code / codex / acp backends once per session (they share the
 * session's process runner and config) and serves lookups by name. The
 * in-process engine path is not a backend — the `Agent` tool keeps it as its
 * default and dispatches to this service only for external names. Bound at
 * Session scope — contributed by the `subagent` domain assembly.
 */

import { Service } from '#/_base/di/service';
import { IConfigService } from '#/app/config/config';
import { ISessionProcessRunner } from '#/session/process/processRunner';

import { AcpBackend } from './acpBackend';
import { ClaudeCodeBackend } from './claudeCodeBackend';
import { CodexBackend } from './codexBackend';
import type {
  ISubagentBackendService} from './subagentBackend';
import {
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
