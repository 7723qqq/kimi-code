import type { DomainEvent } from '@moonshot-ai/agent-core-v2';
import type { ContentPart } from '@moonshot-ai/kosong';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';

export type { ToolInputDisplay } from '@moonshot-ai/protocol';
export { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE } from '@moonshot-ai/protocol';

// Event union plus shared fields/payloads used across event families.
//
// The SDK event channel now carries the v2 engine's native `DomainEvent`
// union. The per-agent bus in agent-core-v2 does not stamp events with the
// owning session/agent ids (the bus is per-agent, so the consumer knows both),
// so the SDK re-adds that stamping on top — consumers rely on
// `event.sessionId` / `event.agentId` for session filtering and subagent
// routing, and the v1 `Event` union they used before carried them directly.
export type DomainEventWithStamps = DomainEvent & { sessionId: string; agentId: string };

/**
 * The one engine fact the v2 engine publishes on the process-global
 * `IEventService` (not a per-agent bus) that the SDK stream carries: the
 * prompt-metadata path. Kept as an explicit member of the SDK `Event` union so
 * hosts can keep switching on it.
 */
export interface SessionMetaUpdatedEvent {
  readonly type: 'session.meta.updated';
  readonly sessionId: string;
  readonly agentId: string;
  readonly title?: string | undefined;
  readonly patch?: Record<string, unknown> | undefined;
}

export type Event = DomainEventWithStamps | SessionMetaUpdatedEvent;
export type { DomainEvent } from '@moonshot-ai/agent-core-v2';

// Approval / question reverse-RPC payloads. These keep the legacy wire shapes
// the SDK exposes to hosts through `setApprovalHandler` / `setQuestionHandler`
// (the v2 engine parks approvals in its interaction kernel; the SDK bridges
// them to these shapes). Localized copies of the v1 definitions so the SDK
// does not import `agent-core`.
export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';
export type ApprovalScope = 'session';

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: ApprovalScope | undefined;
  readonly feedback?: string | undefined;
  readonly selectedLabel?: string | undefined;
}

export interface ApprovalRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
}

export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface QuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly body?: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect?: boolean;
  readonly otherLabel?: string;
  readonly otherDescription?: string;
}

export type QuestionAnswerMethod = 'enter' | 'space' | 'number_key';
/**
 * Flattened answers keyed by question text; values are the chosen option
 * label(s) (comma-joined for multi-select) or free-form "Other" text.
 * `true` marks a question as answered without echoing a concrete value.
 */
export type QuestionAnswers = Record<string, string | true>;

export interface QuestionResponse {
  readonly answers: QuestionAnswers;
  readonly method?: QuestionAnswerMethod | undefined;
}

export type QuestionResult = null | QuestionAnswers | QuestionResponse;

export interface QuestionRequest {
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly questions: readonly QuestionItem[];
}

export interface ToolCallRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly args: unknown;
}

export interface ToolCallResponse {
  readonly output: string | ContentPart[];
  readonly isError?: boolean | undefined;
}

export type MaybePromise<T> = T | Promise<T>;

export type ApprovalHandler = (request: ApprovalRequest) => MaybePromise<ApprovalResponse>;

export type QuestionHandler = (request: QuestionRequest) => MaybePromise<QuestionResult>;
