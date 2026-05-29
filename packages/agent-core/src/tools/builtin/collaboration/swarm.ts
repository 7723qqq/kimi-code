/**
 * SwarmTool — collaboration tool that runs a task as a self-directed agent
 * swarm.
 *
 * Like {@link AgentTool}, this is a "collaboration tool": it uses
 * `SessionSubagentHost` (injected via the constructor) to create in-process
 * subagents. The {@link SwarmCoordinator} dynamically decomposes the task into
 * parallel role-specialized workers, then synthesizes their outputs into one
 * answer.
 *
 * Workers are spawned with an ad-hoc `profileOverride`, and the tool is
 * registered only on non-sub agents so a swarm worker can never launch another
 * swarm (recursion guard).
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { Logger } from '../../../logging';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import { SwarmCoordinator } from '../../../agent/swarm/coordinator';

export const SwarmToolInputSchema = z.object({
  task: z.string().describe('The high-level task to decompose and run as a parallel agent swarm.'),
});

export type SwarmToolInput = z.infer<typeof SwarmToolInputSchema>;

const SWARM_DESCRIPTION =
  'Run a task as a self-directed agent swarm: dynamically decompose it into parallel ' +
  'role-specialized subagents, then synthesize their outputs into one answer. ' +
  'Use for broad, parallelizable tasks (research, multi-file analysis). ' +
  'Subagents run in isolated contexts and cannot themselves launch swarms.';

const DEFAULT_MAX_CONCURRENCY = 4;

export class SwarmTool implements BuiltinTool<SwarmToolInput> {
  readonly name: string = 'Swarm';
  readonly description: string = SWARM_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SwarmToolInputSchema);
  private readonly log: Logger | undefined;

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    options?: { log?: Logger },
  ) {
    this.log = options?.log;
  }

  resolveExecution(args: SwarmToolInput): ToolExecution {
    return {
      description: `Running swarm: ${args.task.slice(0, 60)}`,
      approvalRule: 'Swarm',
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: SwarmToolInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const coordinator = new SwarmCoordinator({
      signal: ctx.signal,
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
      onProgress: (text) => ctx.onUpdate?.({ kind: 'status', text }),
      onProgressCustom: (progress) =>
        ctx.onUpdate?.({ kind: 'custom', customKind: 'swarm', customData: progress }),
      spawnSubagent: async ({ profileName, systemPrompt, tools, prompt, description, signal }) => {
        const handle = await this.subagentHost.spawn(profileName, {
          parentToolCallId: ctx.toolCallId,
          prompt,
          description,
          runInBackground: false,
          signal,
          profileOverride: { systemPrompt, tools },
        });
        return handle.completion;
      },
    });

    try {
      const output = await coordinator.run(args.task);
      return { output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log?.error(`swarm failed: ${message}`);
      return { output: `Swarm failed: ${message}`, isError: true };
    }
  }
}
