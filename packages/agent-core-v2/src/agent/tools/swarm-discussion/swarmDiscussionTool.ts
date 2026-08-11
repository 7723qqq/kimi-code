/**
 * `tools` domain — `SwarmDiscussionTool` implementation (the `SwarmDiscussion`
 * tool).
 *
 * Runs a roundtable discussion or a structured debate among persistent
 * subagents: binds a per-caller `PersistentSubagentHost` from
 * `IPersistentSubagentService` (Session scope) and delegates to the
 * `discussion` coordinators, rendering their results as XML. Enters swarm mode
 * through `IAgentSwarmService` around the run. The caller's agent id comes from
 * `IAgentScopeContext`. Pure tool — owns no scoped state.
 *
 * Registered via the module-level `registerAgentToolService(IAgentSwarmDiscussionTool,
 * SwarmDiscussionTool)` at the bottom of this file — the same "import =
 * register" pattern used by every agent tool. Bound at Agent scope.
 */

import { t } from '@moonshot-ai/kimi-i18n';

import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IPersistentSubagentService } from '#/session/subagent/persistentSubagent';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  SwarmDiscussionCoordinator,
  type DiscussionResult,
} from '#/agent/discussion/coordinator';
import {
  StructuredDebateCoordinator,
  type DebateResult,
} from '#/agent/discussion/debate-coordinator';

import {
  IAgentSwarmDiscussionTool,
  SwarmDiscussionToolInputSchema,
  type SwarmDiscussionToolInput,
} from './swarm-discussion';
import SWARM_DISCUSSION_DESCRIPTION from './swarm-discussion.md?raw';

export class SwarmDiscussionTool implements IAgentSwarmDiscussionTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'SwarmDiscussion' as const;
  readonly description = SWARM_DISCUSSION_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SwarmDiscussionToolInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @IPersistentSubagentService private readonly persistentSubagents: IPersistentSubagentService,
    @IAgentSwarmService private readonly swarmMode: IAgentSwarmService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: SwarmDiscussionToolInput): ToolExecution {
    const participantCount = args.participants.length;
    const mode = args.mode ?? 'discussion';
    return {
      accesses: ToolAccesses.all(),
      description: discussionDescription(mode, args.topic),
      display: {
        kind: 'agent_call',
        agent_name: t('toolsV2.discussion.agentName', {
          mode,
          count: String(participantCount),
        }),
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

      if (args.mode === 'debate') {
        return await this.runDebate(args, context);
      }
      return await this.runDiscussion(args, context);
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private async runDiscussion(
    args: SwarmDiscussionToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const host = this.persistentSubagents.bind(this.callerAgentId);
    const coordinator = new SwarmDiscussionCoordinator(host);
    const result = await coordinator.discuss(
      {
        topic: args.topic,
        participants: args.participants.map((p) => ({
          profileName: p.profileName ?? 'coder',
          roleDescription: p.roleDescription,
          turnsPerRound: 1,
        })),
        maxRounds: args.maxRounds ?? 3,
        summaryPrompt: args.summaryPrompt,
      },
      context.signal,
    );

    return {
      output: formatDiscussionResult(result),
    };
  }

  private async runDebate(
    args: SwarmDiscussionToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const host = this.persistentSubagents.bind(this.callerAgentId);
    const coordinator = new StructuredDebateCoordinator(host);
    const result = await coordinator.debate(
      {
        topic: args.topic,
        participants: args.participants.map((p) => ({
          profileName: p.profileName ?? 'coder',
          roleDescription: p.roleDescription,
          assignedStance: p.assignedStance,
        })),
        maxDebateRounds: args.maxRounds ?? 2,
        consensusPrompt: args.summaryPrompt,
        enableVoting: args.enableVoting ?? false,
      },
      context.signal,
    );

    return {
      output: formatDebateResult(result),
    };
  }
}

registerAgentToolService(IAgentSwarmDiscussionTool, SwarmDiscussionTool, {
  name: 'SwarmDiscussion',
  domain: 'swarm',
});

function discussionDescription(mode: 'discussion' | 'debate', topic: string): string {
  return mode === 'debate'
    ? t('toolsV2.discussion.launchingDebate', { topic })
    : t('toolsV2.discussion.launching', { topic });
}

function formatDiscussionResult(result: DiscussionResult): string {
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

function formatDebateResult(result: DebateResult): string {
  const lines: string[] = [];

  lines.push('<debate_result>');

  const statusText = result.endedBy;
  lines.push(
    `<summary>speeches: ${String(result.transcript.length)}, phases: ${String(result.phases.length)}, cross_refs: ${String(result.crossReferencesCount)}, position_changes: ${String(result.positionChanges)}, status: ${statusText}</summary>`,
  );

  // Phase breakdown
  lines.push('<phases>');
  for (const phase of result.phases) {
    lines.push(`  <phase name="${phase.phase}" speeches="${String(phase.entryCount)}" />`);
  }
  lines.push('</phases>');

  // Full transcript with phase markers
  lines.push('<transcript>');
  for (const entry of result.transcript) {
    lines.push(`[${entry.speaker}] ${entry.content}`);
    lines.push('');
  }
  lines.push('</transcript>');

  if (result.consensus.length > 0) {
    lines.push('<consensus>');
    lines.push(result.consensus);
    lines.push('</consensus>');
  }

  if (result.votingResult.length > 0) {
    lines.push('<voting_result>');
    lines.push(result.votingResult);
    lines.push('</voting_result>');
  }

  lines.push('</debate_result>');

  return lines.join('\n');
}
