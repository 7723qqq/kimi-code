import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { SwarmMode } from '../../../agent/swarm';
import {
  SwarmDiscussionCoordinator,
  type DiscussionObserver,
} from '../../../agent/discussion/coordinator';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import SWARM_DISCUSSION_DESCRIPTION from './swarm-discussion.md?raw';

const SwarmDiscussionToolInputSchema = z.object({
  topic: z.string().trim().min(1).describe('The topic or question to discuss.'),
  participants: z
    .array(
      z.object({
        profileName: z
          .string()
          .trim()
          .min(1)
          .optional()
          .default('coder')
          .describe('Agent profile name, e.g. "coder" or "explore".'),
        roleDescription: z
          .string()
          .trim()
          .min(1)
          .describe('Role description for this participant.'),
        turnsPerRound: z
          .number()
          .int()
          .positive()
          .optional()
          .default(1)
          .describe('How many times this participant speaks per round.'),
      }),
    )
    .min(2)
    .max(10)
    .describe('The participants in the discussion (2-10).'),
  maxRounds: z
    .number()
    .int()
    .positive()
    .optional()
    .default(3)
    .describe('Maximum number of full rounds before the discussion ends.'),
  summaryPrompt: z
    .string()
    .trim()
    .optional()
    .describe('Optional prompt to generate a final summary after the discussion.'),
});

export type SwarmDiscussionToolInput = z.infer<typeof SwarmDiscussionToolInputSchema>;

export class SwarmDiscussionTool implements BuiltinTool<SwarmDiscussionToolInput> {
  readonly name = 'SwarmDiscussion' as const;
  readonly description = SWARM_DISCUSSION_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SwarmDiscussionToolInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly swarmMode: SwarmMode,
  ) {}

  resolveExecution(args: SwarmDiscussionToolInput): ToolExecution {
    const participantCount = args.participants.length;
    return {
      accesses: ToolAccesses.all(),
      description: `Roundtable discussion: ${args.topic}`,
      display: {
        kind: 'agent_call',
        agent_name: `discussion (${String(participantCount)} participants)`,
        prompt: args.topic,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: SwarmDiscussionToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      this.swarmMode.enter('tool');
      const coordinator = new SwarmDiscussionCoordinator(this.subagentHost);
      const result = await coordinator.discuss(
        {
          topic: args.topic,
          participants: args.participants.map((p) => ({
            profileName: p.profileName ?? 'coder',
            roleDescription: p.roleDescription,
            turnsPerRound: p.turnsPerRound ?? 1,
          })),
          maxRounds: args.maxRounds ?? 3,
          summaryPrompt: args.summaryPrompt,
        },
        context.signal,
      );

      return {
        output: formatDiscussionResult(result),
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }
}

function formatDiscussionResult(
  result: import('../../../agent/discussion/coordinator').DiscussionResult,
): string {
  const lines: string[] = [];

  lines.push('<discussion_result>');

  const statusText =
    result.endedBy === 'max_rounds' ? 'completed' : result.endedBy;
  lines.push(
    `<summary>rounds: ${String(result.roundsCompleted)}, speeches: ${String(result.transcript.length)}, status: ${statusText}</summary>`,
  );

  lines.push('<transcript>');
  for (const entry of result.transcript) {
    lines.push(`[${entry.speaker}] ${entry.content}`);
    lines.push('');
  }
  lines.push('</transcript>');

  if (result.summary.length > 0) {
    lines.push('<final_summary>');
    lines.push(result.summary);
    lines.push('</final_summary>');
  }

  lines.push('</discussion_result>');

  return lines.join('\n');
}