import type { Event2 } from '@moonshot-ai/agent-core-v2';
import type { ContentPart } from '@moonshot-ai/kosong';
import type { Event as ProtocolEvent, ToolInputDisplay } from '@moonshot-ai/protocol';

export type { ToolInputDisplay } from '@moonshot-ai/protocol';
export { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE } from '@moonshot-ai/protocol';

// The SDK event stream carries the v1-protocol event shapes: the protocol
// package's `AgentEvent` discriminated union stamped with the owning
// session/agent ids (`Event`). The v2 engine's per-agent bus does not stamp
// events (the bus is per-agent, so the consumer knows both), so the v2 client
// re-adds that stamping on top when it forwards engine events into the SDK
// stream — consumers rely on `event.sessionId` / `event.agentId` for session
// filtering and subagent routing.
export type Event = ProtocolEvent;

// Engine-side event shape (agent-core-v2's `Event2` instances as forwarded by
// the v2 client). Kept separate from the SDK `Event` stream: engine events are
// class instances whose payload fields are only known at runtime.
export type DomainEvent = Event2<Record<string, unknown>>;

export type { SessionMetaUpdatedEvent } from '@moonshot-ai/protocol';

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
