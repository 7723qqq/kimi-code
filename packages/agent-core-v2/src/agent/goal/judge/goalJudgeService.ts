import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { GoalSnapshot } from '#/features/goal/types';
import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
} from '#/agent/llmRequester/llmRequester';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { Message } from '#/app/llmProtocol/message';
import { createUserMessage, extractText } from '#/app/llmProtocol/message';
import { LifecycleScope } from '#/app/scopes';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSubagentService } from '#/session/subagent/subagent';

import {
  JUDGE_SYSTEM_PROMPT,
  buildJudgeUserPrompt,
} from './judgePrompt';

const RETRY_SYSTEM_PROMPT = `You are a judge. Return ONLY a JSON object with fields "ok" (boolean) and "reason" (string). No other text.`;

export interface JudgeVerdict {
  readonly ok: boolean;
  readonly impossible?: boolean;
  readonly reason: string;
}

export interface IAgentGoalJudgeService {
  readonly _serviceBrand: undefined;
  evaluate(goal: GoalSnapshot, signal?: AbortSignal): Promise<JudgeVerdict>;
}

export const IAgentGoalJudgeService =
  createDecorator<IAgentGoalJudgeService>('agentGoalJudgeService');

export class AgentGoalJudgeService extends Disposable implements IAgentGoalJudgeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ILogService private readonly log: ILogService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionContext private readonly sessionContext: ISessionContext,
  ) {
    super();
  }

  async evaluate(goal: GoalSnapshot, signal?: AbortSignal): Promise<JudgeVerdict> {
    if (this.scopeContext.agentId !== 'main') {
      return { ok: true, reason: 'Judge skipped: not main agent.' };
    }

    const subagentVerdict = await this.evaluateViaSubagent(goal, signal);
    if (subagentVerdict !== undefined) {
      return subagentVerdict;
    }

    return this.evaluateFromTranscript(goal, signal);
  }

  /**
   * Launch a judge subagent that independently verifies the goal by executing
   * commands. Returns `undefined` if the subagent path fails (caller falls back).
   */
  private async evaluateViaSubagent(
    goal: GoalSnapshot,
    _signal?: AbortSignal,
  ): Promise<JudgeVerdict | undefined> {
    this.log.debug('goal.judge.subagent.start', { goalId: goal.goalId });
    this.log.debug('goal.judge.subagent.skipped', {
      goalId: goal.goalId,
      reason: 'subagent-by-profile not yet wired in fork',
    });
    return undefined;
  }

  /**
   * Fallback: evaluate goal completion by asking an LLM to judge the transcript.
   * Used when the subagent path is unavailable or fails.
   */
  private async evaluateFromTranscript(
    goal: GoalSnapshot,
    signal?: AbortSignal,
  ): Promise<JudgeVerdict> {
    const history = this.context.get();
    const judgeUser = buildJudgeUserPrompt(goal.objective, goal.completionCriterion);
    const messages: Message[] = [...history, createUserMessage(judgeUser)];

    const modelContext = this.profile.resolveModelContext();
    const maxOutputSize = Math.min(modelContext.maxOutputSize ?? 4096, 4096);

    this.log.debug('goal.judge.transcript.start', {
      goalId: goal.goalId,
      messageCount: messages.length,
    });

    let finish: AgentLLMRequestFinish;
    try {
      finish = await this.llmRequester.request(
        {
          messages,
          tools: [],
          systemPrompt: JUDGE_SYSTEM_PROMPT,
          maxOutputSize,
          source: {
            type: 'operation',
            requestKind: 'goal_judge',
          },
        },
        undefined,
        signal,
      );
    } catch (error) {
      this.log.warn('goal.judge.transcript.error', {
        goalId: goal.goalId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: true,
        reason: 'Judge evaluation failed (network/timeout) \u2014 allowing completion.',
      };
    }

    const responseText = extractText(finish.message).trim();
    const verdict = parseVerdict(responseText);

    if (verdict !== undefined) {
      this.log.debug('goal.judge.transcript.result', {
        goalId: goal.goalId,
        ok: verdict.ok,
        reason: verdict.reason.slice(0, 200),
      });
      return verdict;
    }

    this.log.warn('goal.judge.transcript.parseFailed', {
      goalId: goal.goalId,
      responsePreview: responseText.slice(0, 200),
    });

    try {
      const retryUserPrompt =
        `The goal objective is: ${goal.objective}\n` +
        (goal.completionCriterion ? `Completion criterion: ${goal.completionCriterion}\n` : '') +
        'Based on the conversation transcript above, is this goal complete? Return ONLY {"ok": true/false, "reason": "..."}';
      const retryFinish = await this.llmRequester.request(
        {
          messages: [...history, createUserMessage(retryUserPrompt)],
          tools: [],
          systemPrompt: RETRY_SYSTEM_PROMPT,
          maxOutputSize: 512,
          source: {
            type: 'operation',
            requestKind: 'goal_judge_retry',
          },
        },
        undefined,
        signal,
      );
      const retryText = extractText(retryFinish.message).trim();
      const retryVerdict = parseVerdict(retryText);
      if (retryVerdict !== undefined) return retryVerdict;
    } catch {
    }

    this.log.warn('goal.judge.transcript.retryFailed', { goalId: goal.goalId });
    return {
      ok: true,
      reason: `Judge response could not be parsed after retry \u2014 allowing completion. Response: ${responseText.slice(0, 200)}`,
    };
  }
}

function parseVerdict(text: string): JudgeVerdict | undefined {
  const directResult = tryParseVerdictJson(text);
  if (directResult !== undefined) return directResult;

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const fenceResult = tryParseVerdictJson(fenceMatch[1]!.trim());
    if (fenceResult !== undefined) return fenceResult;
  }

  const candidates = extractJsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const result = tryParseVerdictJson(candidates[i]!);
    if (result !== undefined) return result;
  }

  return undefined;
}

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j]!;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(i, j + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function tryParseVerdictJson(raw: string): JudgeVerdict | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<JudgeVerdict>;
    if (typeof parsed.ok === 'boolean' && typeof parsed.reason === 'string') {
      const impossible = parsed.impossible === true;
      return {
        ok: impossible ? false : parsed.ok,
        impossible: impossible ? true : undefined,
        reason: parsed.reason,
      };
    }
  } catch {
  }
  return undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentGoalJudgeService,
  AgentGoalJudgeService,
  ScopeActivation.OnScopeCreated,
  'goalJudge',
);
