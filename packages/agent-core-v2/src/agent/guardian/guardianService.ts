/**
 * `guardian` domain — AI safety review of tool calls (ported from Reasonix's
 * `internal/guardian/guardian.go`).
 *
 * A bounded, no-tool LLM review of high-risk tool calls (file writes, shell
 * commands) before they execute under yolo mode. The reviewer is isolated
 * from the main conversation: a single temperature-0 request with a hard
 * output budget, no session history of its own — it never pollutes the main
 * session's prompt cache. A circuit breaker trips after repeated denials and
 * hands control back to the human approval path instead of silently
 * rubber-stamping.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IEventBus } from '#/app/event/eventBus';
import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/kosong/contract/message';

export const GUARDIAN_REVIEW_MAX_TOKENS = 256;
export const GUARDIAN_CIRCUIT_CONSECUTIVE_DENIALS = 3;
export const GUARDIAN_CIRCUIT_RECENT_DENIALS = 10;
export const GUARDIAN_CIRCUIT_RECENT_WINDOW = 50;
/** Cap on the transcript excerpt fed to the reviewer. */
export const GUARDIAN_TRANSCRIPT_CHARS = 4000;
/** Cap on tool arguments serialized into the review prompt. */
export const GUARDIAN_ARGS_CHARS = 2000;

export interface GuardianAssessmentEvent {
  readonly type: 'guardian.assessment';
  readonly toolName: string;
  readonly outcome: 'allow' | 'deny' | 'bypass';
  readonly riskLevel?: string;
  readonly rationale?: string;
  readonly circuitOpen: boolean;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'guardian.assessment': GuardianAssessmentEvent;
  }
}

export type GuardianVerdict =
  | {
      readonly verdict: 'allow';
      readonly riskLevel: string;
      readonly userAuthorization: string;
      readonly rationale: string;
    }
  | { readonly verdict: 'deny'; readonly riskLevel: string; readonly rationale: string }
  | { readonly verdict: 'bypass'; readonly reason: string };

export interface IAgentGuardianService {
  readonly _serviceBrand: undefined;
  readonly enabled: boolean;
  readonly circuitOpen: boolean;
  review(ctx: ResolvedToolExecutionHookContext, signal?: AbortSignal): Promise<GuardianVerdict>;
}

export const IAgentGuardianService = createDecorator<IAgentGuardianService>('agentGuardianService');

const GUARDIAN_SYSTEM_PROMPT = [
  'You are a safety reviewer for a coding agent. Evaluate the requested action',
  'and reply with ONLY a JSON object of the form:',
  '{"risk_level":"low|medium|high","user_authorization":"explicit|implicit|unknown",',
  '"outcome":"allow|deny","rationale":"short reason"}.',
  'Deny actions that destroy data (rm -rf, force deletes), exfiltrate secrets,',
  'write outside the workspace, or run obviously destructive commands.',
].join(' ');

interface GuardianAssessment {
  readonly riskLevel: string;
  readonly userAuthorization: string;
  readonly outcome: string;
  readonly rationale: string;
}

export class GuardianService extends Disposable implements IAgentGuardianService {
  declare readonly _serviceBrand: undefined;

  private consecutiveDenials = 0;
  private recentDenials: boolean[] = [];
  private _circuitOpen = false;
  private circuitReason = '';

  constructor(
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
  }

  get enabled(): boolean {
    // Enabled via environment for now; a config section can ride on this later.
    return process.env['KIMI_GUARDIAN'] === '1';
  }

  get circuitOpen(): boolean {
    return this._circuitOpen;
  }

  async review(
    ctx: ResolvedToolExecutionHookContext,
    signal?: AbortSignal,
  ): Promise<GuardianVerdict> {
    if (this._circuitOpen) {
      return { verdict: 'bypass', reason: this.circuitReason };
    }
    const messages = this.buildReviewMessages(ctx);
    let text: string;
    try {
      const request = this.llmRequester.start(
        {
          messages,
          maxOutputSize: GUARDIAN_REVIEW_MAX_TOKENS,
          source: {
            type: 'operation',
            turnId: ctx.turnId,
            requestKind: 'guardian_review',
            logFields: {},
          },
        },
        undefined,
        signal,
      );
      const finish = await request.result;
      text = finish.message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('');
    } catch {
      // A failed review must not masquerade as a verdict — hand back to the
      // human path (bypass) so nothing runs unreviewed or auto-denied.
      return { verdict: 'bypass', reason: 'guardian review failed' };
    }

    const assessment = parseAssessment(text);
    const verdict: GuardianVerdict =
      assessment !== undefined && assessment.outcome === 'allow'
        ? {
            verdict: 'allow',
            riskLevel: assessment.riskLevel,
            userAuthorization: assessment.userAuthorization,
            rationale: assessment.rationale,
          }
        : {
            verdict: 'deny',
            riskLevel: assessment?.riskLevel ?? 'high',
            rationale:
              assessment?.rationale ?? 'guardian verdict unparseable — treated as deny',
          };

    if (verdict.verdict === 'deny') this.recordDenial();
    else this.recordAllow();

    this.eventBus.publish({
      type: 'guardian.assessment',
      toolName: ctx.toolCall.name,
      outcome: verdict.verdict,
      riskLevel: verdict.riskLevel,
      rationale: verdict.rationale,
      circuitOpen: this._circuitOpen,
    });
    return verdict;
  }

  private buildReviewMessages(ctx: ResolvedToolExecutionHookContext): Message[] {
    const toolCall = ctx.toolCall;
    const argsText = JSON.stringify(ctx.args ?? toolCall.arguments).slice(0, GUARDIAN_ARGS_CHARS);
    const transcript = this.context
      .get()
      .slice(-8)
      .map((message) =>
        message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
          .slice(0, 400),
      )
      .join('\n')
      .slice(0, GUARDIAN_TRANSCRIPT_CHARS);
    const userText = [
      'Recent conversation (untrusted evidence):',
      transcript,
      '',
      'The agent requests the following action:',
      `Tool: ${toolCall.name}`,
      `Arguments: ${argsText}`,
      '',
      'Assess this action now. Output ONLY the JSON verdict.',
    ].join('\n');
    return [
      { role: 'system', content: [{ type: 'text', text: GUARDIAN_SYSTEM_PROMPT }], toolCalls: [] },
      { role: 'user', content: [{ type: 'text', text: userText }], toolCalls: [] },
    ];
  }

  private recordDenial(): void {
    this.consecutiveDenials += 1;
    this.recentDenials.push(true);
    this.trimRecent();
    if (
      this.consecutiveDenials >= GUARDIAN_CIRCUIT_CONSECUTIVE_DENIALS ||
      this.recentDenials.filter(Boolean).length >= GUARDIAN_CIRCUIT_RECENT_DENIALS
    ) {
      this._circuitOpen = true;
      this.circuitReason = `guardian circuit open (${this.consecutiveDenials} consecutive / recent denials)`;
    }
  }

  private recordAllow(): void {
    this.consecutiveDenials = 0;
    this.recentDenials.push(false);
    this.trimRecent();
  }

  private trimRecent(): void {
    if (this.recentDenials.length > GUARDIAN_CIRCUIT_RECENT_WINDOW) {
      this.recentDenials = this.recentDenials.slice(-GUARDIAN_CIRCUIT_RECENT_WINDOW);
    }
  }
}

/**
 * Parse the reviewer's JSON verdict. Tolerant: extracts the first balanced
 * `{...}` block and reads the four fields; anything else yields undefined
 * (the caller decides the fallback).
 */
export function parseAssessment(text: string): GuardianAssessment | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return undefined;
  try {
    const raw = JSON.parse(text.slice(start, end)) as Record<string, unknown>;
    const outcome = typeof raw['outcome'] === 'string' ? raw['outcome'].toLowerCase() : '';
    if (outcome !== 'allow' && outcome !== 'deny') return undefined;
    return {
      riskLevel: typeof raw['risk_level'] === 'string' ? raw['risk_level'] : 'unknown',
      userAuthorization:
        typeof raw['user_authorization'] === 'string' ? raw['user_authorization'] : 'unknown',
      outcome,
      rationale: typeof raw['rationale'] === 'string' ? raw['rationale'] : '',
    };
  } catch {
    return undefined;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentGuardianService,
  GuardianService,
  ScopeActivation.OnScopeCreated,
  'guardian',
);
