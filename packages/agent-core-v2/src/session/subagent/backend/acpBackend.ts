/**
 * `subagent` domain — the `acp` external subagent backend.
 *
 * Spawns any Agent Client Protocol (ACP) implementation through
 * `ISessionProcessRunner` and drives one turn over the ACP SDK's
 * `ClientSideConnection` (newline-delimited JSON-RPC over stdio):
 * initialize → newSession(cwd) → prompt(text). `agent_message_chunk`
 * updates are folded into the output; the prompt response's stop reason
 * settles the run. Permission requests are auto-cancelled (the subagent runs
 * unattended). Aborting the request signal cancels the remote turn; dispose
 * tears the connection and process down. Bound at Session scope via
 * `SubagentBackendService`.
 */

import { randomUUID } from 'node:crypto';
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream';

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent as AcpAgent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk';

import { IConfigService } from '#/app/config/config';
import type { ISessionProcessRunner } from '#/session/process/processRunner';

import {
  SUBAGENT_BACKEND_SECTION,
  type AcpBackendConfig,
  type SubagentBackendConfig,
} from './configSection';
import type {
  ISubagentBackend,
  SubagentBackendResult,
  SubagentBackendRun,
  SubagentBackendStartRequest,
  SubagentBackendStopReason,
} from './subagentBackend';

export class AcpBackend implements ISubagentBackend {
  readonly name = 'acp' as const;

  private readonly config: AcpBackendConfig | undefined;

  constructor(
    private readonly processRunner: ISessionProcessRunner,
    @IConfigService config: IConfigService,
  ) {
    this.config = config.get<SubagentBackendConfig | undefined>(SUBAGENT_BACKEND_SECTION)?.acp;
  }

  async start(request: SubagentBackendStartRequest): Promise<SubagentBackendRun> {
    if (this.config === undefined) {
      throw new Error(
        'the acp subagent backend needs a server configured in the [subagentBackend] config section: `acp = { command = "..." }`',
      );
    }
    const process = await this.processRunner.exec([this.config.command, ...(this.config.args ?? [])], {
      cwd: request.cwd,
      env: this.config.env,
    });
    const controller = new AbortController();
    const abortFromSignal = (): void => {
      controller.abort(request.signal.reason);
    };
    request.signal.addEventListener('abort', abortFromSignal, { once: true });

    const result = new Promise<SubagentBackendResult>((resolve, reject) => {
      void (async () => {
        let output = '';
        const makeClient = (_agent: AcpAgent): Client => ({
          sessionUpdate(params: SessionNotification): Promise<void> {
            const update = params.update;
            if (update.sessionUpdate === 'agent_message_chunk') {
              const content = update.content;
              if (content.type === 'text') {
                output += content.text;
              }
            }
            return Promise.resolve();
          },
          requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
            return Promise.resolve({ outcome: { outcome: 'cancelled' } });
          },
        });
        const connection = new ClientSideConnection(
          makeClient,
          ndJsonStream(
            NodeWritable.toWeb(process.stdin) as WritableStream<Uint8Array>,
            NodeReadable.toWeb(process.stdout) as ReadableStream<Uint8Array>,
          ),
        );
        try {
          await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
          const session = await connection.newSession({ cwd: request.cwd, mcpServers: [] });
          const sessionId: unknown = Reflect.get(session, 'sessionId');
          if (typeof sessionId !== 'string') {
            throw new TypeError('ACP child published without a session id');
          }
          const promptResult = await connection.prompt({
            sessionId,
            prompt: [{ type: 'text', text: request.prompt }],
          });
          resolve({ output, stopReason: acpStopReason(promptResult.stopReason) });
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
      id: `acp-${randomUUID()}`,
      result,
      dispose: async () => {
        controller.abort();
        request.signal.removeEventListener('abort', abortFromSignal);
        try {
          await process.kill('SIGTERM');
        } catch {
          // Process already gone.
        }
      },
    };
  }
}

export function acpStopReason(reason: StopReason): SubagentBackendStopReason {
  switch (reason) {
    case 'end_turn':
      return 'completed';
    case 'max_tokens':
      return 'max-tokens';
    case 'refusal':
      return 'refusal';
    case 'cancelled':
      return 'aborted';
    default:
      return 'error';
  }
}
