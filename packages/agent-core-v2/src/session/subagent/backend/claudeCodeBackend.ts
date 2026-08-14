/**
 * `subagent` domain — the `claude-code` external subagent backend.
 *
 * Runs one Claude Code turn through the official `@anthropic-ai/claude-agent-sdk`
 * `query()` stream: the prompt is sent as a single text block, assistant text
 * is accumulated from stream events, and the run settles on the SDK's result
 * message (an `is_error` result settles as `error`). Aborting the request
 * signal aborts the SDK query; dispose closes the query and terminates the
 * CLI process. Bound at Session scope via `SubagentBackendService`.
 */

import { randomUUID } from 'node:crypto';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { IConfigService } from '#/app/config/config';

import {
  SUBAGENT_BACKEND_SECTION,
  type ClaudeCodeBackendConfig,
  type SubagentBackendConfig,
} from './configSection';
import type {
  ISubagentBackend,
  SubagentBackendResult,
  SubagentBackendRun,
  SubagentBackendStartRequest,
} from './subagentBackend';

export class ClaudeCodeBackend implements ISubagentBackend {
  readonly name = 'claude-code' as const;

  private readonly config: ClaudeCodeBackendConfig | undefined;

  constructor(@IConfigService config: IConfigService) {
    this.config = config.get<SubagentBackendConfig | undefined>(SUBAGENT_BACKEND_SECTION)?.claudeCode;
  }

  async start(request: SubagentBackendStartRequest): Promise<SubagentBackendRun> {
    const controller = new AbortController();
    const abortFromSignal = (): void => {
      controller.abort(request.signal.reason);
    };
    request.signal.addEventListener('abort', abortFromSignal, { once: true });

    const result = new Promise<SubagentBackendResult>((resolve, reject) => {
      void (async () => {
        let output = '';
        try {
          const stream = query(
            {
              prompt: request.prompt,
              options: {
                cwd: request.cwd,
                ...(this.config?.model === undefined ? {} : { model: this.config.model }),
                abortController: controller,
              },
            },
          );
          for await (const event of stream) {
            if (event.type === 'result') {
              if (event.is_error) {
                resolve({ output, stopReason: 'error' });
              } else {
                resolve({ output, stopReason: 'completed' });
              }
              return;
            }
            if (event.type === 'stream_event' && event.event.type === 'text') {
              output += event.event.text;
            }
          }
          resolve({ output, stopReason: 'completed' });
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
      id: `claude-code-${randomUUID()}`,
      result,
      dispose: async () => {
        controller.abort();
        request.signal.removeEventListener('abort', abortFromSignal);
      },
    };
  }
}
