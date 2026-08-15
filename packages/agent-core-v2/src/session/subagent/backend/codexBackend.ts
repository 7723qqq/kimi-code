/**
 * `subagent` domain — the `codex` external subagent backend.
 *
 * Spawns `codex app-server --stdio` through `ISessionProcessRunner` and
 * drives one turn over the newline-delimited JSON-RPC wire: initialize →
 * startThread(cwd) → runTurn(prompt). Turn text is accumulated from
 * `turn/updated` notifications; `turn/complete` settles the run. Approval
 * requests are auto-declined (the subagent runs unattended). Aborting the
 * request signal aborts the wire request and tears the process down on
 * dispose. Bound at Session scope via `SubagentBackendService`.
 */

import { randomUUID } from 'node:crypto';

import { IConfigService } from '#/app/config/config';
import type { ISessionProcessRunner } from '#/session/process/processRunner';

import { CodexWire } from './codexWire';
import {
  SUBAGENT_BACKEND_SECTION,
  type CodexBackendConfig,
  type SubagentBackendConfig,
} from './configSection';
import type {
  ISubagentBackend,
  SubagentBackendResult,
  SubagentBackendRun,
  SubagentBackendStartRequest,
} from './subagentBackend';

interface TurnUpdatedParams {
  readonly threadId?: unknown;
  readonly turnId?: unknown;
  readonly text?: unknown;
}

interface TurnCompleteParams {
  readonly threadId?: unknown;
  readonly turnId?: unknown;
  readonly status?: unknown;
}

interface ApprovalRequestedParams {
  readonly id?: unknown;
}

export class CodexBackend implements ISubagentBackend {
  readonly name = 'codex' as const;

  private readonly config: CodexBackendConfig | undefined;

  constructor(
    private readonly processRunner: ISessionProcessRunner,
    @IConfigService config: IConfigService,
  ) {
    this.config = config.get<SubagentBackendConfig | undefined>(SUBAGENT_BACKEND_SECTION)?.codex;
  }

  async start(request: SubagentBackendStartRequest): Promise<SubagentBackendRun> {
    const command = this.config?.command ?? 'codex';
    const process = await this.processRunner.exec([command, 'app-server', '--stdio'], {
      cwd: request.cwd,
    });
    const wire = new CodexWire(process);
    const controller = new AbortController();
    const abortFromSignal = (): void => {
      controller.abort(request.signal.reason);
    };
    request.signal.addEventListener('abort', abortFromSignal, { once: true });

    const result = new Promise<SubagentBackendResult>((resolve, reject) => {
      void (async () => {
        let output = '';
        try {
          await wire.request(
            'initialize',
            {
              protocolVersion: 1,
              modelProvider: 'openai',
              model: this.config?.model ?? 'gpt-5',
            },
            controller.signal,
          );
          const thread = (await wire.request(
            'startThread',
            { cwd: request.cwd },
            controller.signal,
          )) as {
            readonly threadId: string;
          };
          const threadId = thread.threadId;

          const onTurnUpdated = (params: TurnUpdatedParams): void => {
            if (typeof params.text === 'string') {
              output += params.text;
            }
          };
          const onTurnComplete = (params: TurnCompleteParams): void => {
            if (params.status === 'completed') {
              resolve({ output, stopReason: 'completed' });
            } else {
              resolve({ output, stopReason: 'error' });
            }
          };
          const onApproval = (params: ApprovalRequestedParams): void => {
            if (typeof params.id === 'string' || typeof params.id === 'number') {
              wire.notify('approval/respond', {
                id: params.id,
                response: { type: 'cancel' },
              });
            }
          };
          wire.onNotification('turn/updated', onTurnUpdated);
          wire.onNotification('turn/complete', onTurnComplete);
          wire.onNotification('approval/requested', onApproval);

          await wire.request('runTurn', { threadId, texts: [request.prompt] }, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) {
            resolve({ output, stopReason: 'aborted' });
          } else {
            reject(error);
          }
        }
      })();
    });

    return {
      id: `codex-${randomUUID()}`,
      result,
      dispose: async () => {
        controller.abort();
        request.signal.removeEventListener('abort', abortFromSignal);
        wire.dispose();
        try {
          await process.kill('SIGTERM');
        } catch {
          // Process already gone.
        }
      },
    };
  }
}
