import type { PersistentSubagentHost } from '#/session/subagent/persistentSubagent';
import { addUsage, type TokenUsage } from '#human/llm/usage';

import { DiscussionContext, type DiscussionEntry } from './context';

export interface DiscussionParticipantConfig {
  readonly profileName: string;
  readonly roleDescription: string;
  readonly turnsPerRound?: number;
}

export interface DiscussionOptions {
  readonly topic: string;
  readonly participants: DiscussionParticipantConfig[];
  readonly maxRounds?: number;
  readonly summaryPrompt?: string;
}

export interface DiscussionResult {
  readonly transcript: readonly DiscussionEntry[];
  readonly summary: string;
  readonly roundsCompleted: number;
  readonly endedBy: 'max_rounds' | 'cancelled' | 'failed';
  readonly usage: TokenUsage;
}

export interface DiscussionTurnEvent {
  readonly agentId: string;
  readonly roleName: string;
  readonly round: number;
  readonly content: string;
}

export type DiscussionObserver = (event: DiscussionTurnEvent) => void;

export class TeamCoordinator {
  private readonly agentIds: string[] = [];
  private readonly observer: DiscussionObserver | undefined;

  constructor(
    private readonly subagentHost: PersistentSubagentHost,
    options?: { readonly observer?: DiscussionObserver },
  ) {
    this.observer = options?.observer;
  }

  async discuss(options: DiscussionOptions, signal: AbortSignal): Promise<DiscussionResult> {
    const maxRounds = options.maxRounds ?? 3;
    const context = new DiscussionContext();
    let endedBy: DiscussionResult['endedBy'] = 'max_rounds';

    try {
      for (const participant of options.participants) {
        signal.throwIfAborted();
        const agentId = await this.subagentHost.spawnPersistent({
          profileName: participant.profileName,
          prompt: '',
          description: participant.roleDescription,
          parentToolCallId: 'discussion',
          runInBackground: false,
          signal,
        });
        this.agentIds.push(agentId);
      }

      let roundsCompleted = 0;
      for (let round = 1; round <= maxRounds; round += 1) {
        signal.throwIfAborted();

        for (const [index, participant] of options.participants.entries()) {
          signal.throwIfAborted();
          const agentId = this.agentIds[index]!;
          const turnsThisRound = participant.turnsPerRound ?? 1;

          for (let turn = 0; turn < turnsThisRound; turn += 1) {
            signal.throwIfAborted();

            const prompt = this.buildTurnPrompt(
              participant.roleDescription,
              options.topic,
              context,
            );

            const content = await this.subagentHost.runDiscussionTurn(agentId, prompt, signal);

            context.addEntry(participant.profileName, agentId, content, round);

            this.observer?.({
              agentId,
              roleName: participant.profileName,
              round,
              content,
            });
          }
        }

        roundsCompleted = round;
      }

      let summary = '';
      if (options.summaryPrompt !== undefined && !context.isEmpty()) {
        summary = await this.generateSummary(options.summaryPrompt, context, signal);
      }

      const usage = this.collectUsage();

      return {
        transcript: context.allEntries(),
        summary,
        roundsCompleted,
        endedBy,
        usage,
      };
    } catch (error) {
      if (isCancelled(error, signal)) {
        endedBy = 'cancelled';
      } else {
        endedBy = 'failed';
      }

      const usage = this.collectUsage();
      return {
        transcript: context.allEntries(),
        summary: '',
        roundsCompleted: context.getRound(),
        endedBy,
        usage,
      };
    } finally {
      await this.destroyAll();
    }
  }

  private buildTurnPrompt(
    roleDescription: string,
    topic: string,
    context: DiscussionContext,
  ): string {
    const parts: string[] = [];

    parts.push(`[System] Your role:\n${roleDescription}`);
    parts.push('');

    parts.push(`Discussion topic:\n${topic}`);
    parts.push('');

    const transcript = context.getTranscript();
    if (transcript.length > 0) {
      parts.push('Current discussion transcript:');
      parts.push(transcript);
      parts.push('');
      parts.push(
        'Continue the discussion based on what has been said so far. ' +
          'Respond naturally, as if you are in a roundtable conversation.',
      );
    } else {
      parts.push('You are the first to speak. Present your initial thoughts ' + 'on the topic.');
    }

    return parts.join('\n');
  }

  private async generateSummary(
    summaryPrompt: string,
    context: DiscussionContext,
    signal: AbortSignal,
  ): Promise<string> {
    const firstAgentId = this.agentIds[0];
    if (firstAgentId === undefined) return '';

    try {
      const prompt = [
        summaryPrompt,
        '',
        'Full discussion transcript:',
        context.getTranscript(),
        '',
        'Please provide a concise summary of the discussion.',
      ].join('\n');

      return await this.subagentHost.runDiscussionTurn(firstAgentId, prompt, signal);
    } catch {
      return '';
    }
  }

  private collectUsage(): TokenUsage {
    let total: TokenUsage | undefined;

    for (const agentId of this.agentIds) {
      const usage = this.subagentHost.getPersistentUsage(agentId);
      if (usage === undefined) continue;
      total = total === undefined ? { ...usage } : addUsage(total, usage);
    }

    return total ?? { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
  }

  private async destroyAll(): Promise<void> {
    for (const agentId of this.agentIds) {
      try {
        await this.subagentHost.destroyPersistent(agentId);
      } catch {}
    }
    this.agentIds.length = 0;
  }
}

function isCancelled(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
}
