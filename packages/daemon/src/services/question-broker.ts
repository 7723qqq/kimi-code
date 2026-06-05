/**
 * `DaemonQuestionBroker` (W8.2 / Chain 6; was W4.4 stub).
 *
 * Reverse-RPC broker for Question (data-collection) interaction. Mirrors
 * `DaemonApprovalBroker` with one addition: `dismiss(id)` is a first-class
 * outcome (SCHEMAS.md §6.3) — the user closes the panel without answering;
 * agent-core's pending Promise resolves with `null` (NOT a rejection).
 *
 *   1. `request(req)`:
 *        - Mints `question_id = ulid()`.
 *        - Builds protocol `QuestionRequest` via the services adapter
 *          (`questionToBrokerRequest`).
 *        - Broadcasts `event.question.requested` through `IEventBus.publish`.
 *        - Holds the Promise + 60s timer; on resolve, settles with normalized
 *          answers; on dismiss, settles with `null`; on timeout, broadcasts
 *          `event.question.expired` and rejects with `QuestionExpiredError`.
 *
 *   2. `resolve(questionId, response)`:
 *        - Broadcasts `event.question.answered`.
 *        - Settles Promise with adapter-normalized `Record<string, string|true>`.
 *
 *   3. `dismiss(questionId)`:
 *        - Broadcasts `event.question.dismissed`.
 *        - Settles Promise with `null` (== SCHEMAS §6.3 dismissed result).
 *
 * **Anti-corruption**: imports `@moonshot-ai/services` (broker interface +
 * adapter) and `@moonshot-ai/protocol` (Event type). No direct node-sdk
 * references — in-process `QuestionRequest`/`QuestionResult` flow through
 * the services re-export.
 */

import { ulid } from 'ulid';

import { Disposable } from '@moonshot-ai/agent-core';
import type { Event } from '@moonshot-ai/protocol';
import {
  IEventBus,
  IQuestionBroker,
  questionDismissedResult,
  questionToBrokerRequest,
  type QuestionRequest,
  type QuestionResult,
} from '@moonshot-ai/services';

import type { ILogger } from './logger.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typeAnchor: typeof IQuestionBroker = IQuestionBroker;

/** Default 60s timeout per SCHEMAS §6.2 / §6.3. Overridable for tests. */
export const QUESTION_DEFAULT_TIMEOUT_MS = 60_000;

/** Cap on recently-resolved bookkeeping ring (idempotency window). */
export const QUESTION_RECENTLY_RESOLVED_CAP = 1024;

/**
 * Thrown when the 60s timer fires before `resolve()` / `dismiss()` is called.
 */
export class QuestionExpiredError extends Error {
  constructor(public readonly questionId: string, timeoutMs: number) {
    super(`question ${questionId} expired after ${timeoutMs}ms`);
    this.name = 'QuestionExpiredError';
  }
}

interface PendingQuestion {
  readonly questionId: string;
  readonly sessionId: string;
  readonly toolCallId: string | undefined;
  readonly createdAt: string;
  readonly expiresAt: string;
  resolve: (r: QuestionResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DaemonQuestionBrokerOptions {
  timeoutMs?: number;
  recentlyResolvedCap?: number;
}

export class DaemonQuestionBroker extends Disposable implements IQuestionBroker {
  /** Indexed by daemon-minted `question_id` (REST path key). */
  private readonly _pending = new Map<string, PendingQuestion>();
  /** Bounded set of resolved/dismissed ids for idempotency. */
  private readonly _recentlyResolved = new Set<string>();
  private readonly _timeoutMs: number;
  private readonly _recentlyResolvedCap: number;

  constructor(
    private readonly logger: ILogger,
    private readonly eventBus: IEventBus,
    options: DaemonQuestionBrokerOptions = {},
  ) {
    super();
    this._timeoutMs = options.timeoutMs ?? QUESTION_DEFAULT_TIMEOUT_MS;
    this._recentlyResolvedCap =
      options.recentlyResolvedCap ?? QUESTION_RECENTLY_RESOLVED_CAP;
  }

  async request(
    req: QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult> {
    if (this._isDisposed) {
      throw new Error('question broker disposed');
    }

    const questionId = ulid();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this._timeoutMs).toISOString();

    const protocolRequest = questionToBrokerRequest(req, {
      questionId,
      sessionId: req.sessionId,
      createdAt,
      expiresAt,
    });

    const event: Event = {
      type: 'event.question.requested',
      sessionId: req.sessionId,
      agentId: req.agentId,
      ...protocolRequest,
    } as unknown as Event;
    this.eventBus.publish(event);

    this.logger.info(
      {
        questionId,
        sessionId: req.sessionId,
        agentId: req.agentId,
        toolCallId: req.toolCallId,
        questionCount: req.questions.length,
      },
      'question requested',
    );

    return await new Promise<QuestionResult>((resolve, reject) => {
      const timer = setTimeout(() => this._expire(questionId), this._timeoutMs);
      timer.unref?.();
      this._pending.set(questionId, {
        questionId,
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        createdAt,
        expiresAt,
        resolve,
        reject,
        timer,
      });
    });
  }

  /**
   * Settle a pending question with answers (normalized to in-process shape
   * by the REST handler via `questionToAgentCoreResponse`). Broadcasts
   * `event.question.answered` before settling. Silent no-op for unknown ids.
   */
  resolve(id: string, response: QuestionResult): void {
    const p = this._pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this._pending.delete(id);
    this.markResolved(p.questionId);

    const resolvedAt = new Date().toISOString();
    // For broadcast, we forward the in-process answers map directly so all
    // subscribers see consistent shape. (REST handler stamps the wire shape
    // before this broadcast; for in-process internal callers — none today —
    // the broadcast still carries the SDK shape, which is acceptable for
    // Stage 1 until WS.md §7.5 wire-renaming lands.)
    const answeredEvent: Event = {
      type: 'event.question.answered',
      sessionId: p.sessionId,
      agentId: 'main',
      question_id: p.questionId,
      answers: response === null ? null : (response as { answers?: unknown }).answers ?? response,
      resolved_at: resolvedAt,
    } as unknown as Event;
    this.eventBus.publish(answeredEvent);

    p.resolve(response);
  }

  /**
   * SCHEMAS §6.3 dismiss path. Broadcasts `event.question.dismissed` BEFORE
   * settling the Promise with `null` (== `dismissedQuestionResult()` in
   * agent-core). Silent no-op for unknown ids.
   */
  dismiss(id: string): void {
    const p = this._pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this._pending.delete(id);
    this.markResolved(p.questionId);

    const dismissedAt = new Date().toISOString();
    const dismissedEvent: Event = {
      type: 'event.question.dismissed',
      sessionId: p.sessionId,
      agentId: 'main',
      question_id: p.questionId,
      dismissed_at: dismissedAt,
    } as unknown as Event;
    this.eventBus.publish(dismissedEvent);

    p.resolve(questionDismissedResult());
  }

  /**
   * Has-pending check used by REST routes to discriminate 40404 vs proceed.
   */
  isPending(questionId: string): boolean {
    return this._pending.has(questionId);
  }

  /** Has-recently-resolved-or-dismissed check for 40902 idempotency. */
  isRecentlyResolved(questionId: string): boolean {
    return this._recentlyResolved.has(questionId);
  }

  /** Stamp an id as resolved/dismissed for the idempotency window. */
  markResolved(questionId: string): void {
    if (this._recentlyResolved.size >= this._recentlyResolvedCap) {
      const oldest = this._recentlyResolved.values().next().value;
      if (oldest !== undefined) this._recentlyResolved.delete(oldest);
    }
    this._recentlyResolved.add(questionId);
  }

  /** Test helper — number of pending questions. */
  _pendingCountForTest(): number {
    return this._pending.size;
  }

  /** Test helper — pending entry snapshot. */
  _peekPendingForTest(
    questionId: string,
  ): { sessionId: string; toolCallId: string | undefined } | undefined {
    const p = this._pending.get(questionId);
    if (!p) return undefined;
    return { sessionId: p.sessionId, toolCallId: p.toolCallId };
  }

  private _expire(questionId: string): void {
    const p = this._pending.get(questionId);
    if (!p) return;
    this._pending.delete(questionId);
    this.markResolved(p.questionId);

    const expiredEvent: Event = {
      type: 'event.question.expired',
      sessionId: p.sessionId,
      agentId: 'main',
      question_id: p.questionId,
    } as unknown as Event;
    this.eventBus.publish(expiredEvent);

    p.reject(new QuestionExpiredError(p.questionId, this._timeoutMs));
  }

  override dispose(): void {
    if (this._isDisposed) return;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      try {
        p.reject(new Error('daemon shutting down'));
      } catch {
        // ignore
      }
    }
    this._pending.clear();
    this._recentlyResolved.clear();
    super.dispose();
  }
}
