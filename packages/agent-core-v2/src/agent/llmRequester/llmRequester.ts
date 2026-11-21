import { createDecorator } from '#/_base/di/instantiation';
import type {
  AssistantMessage,
  FinishReason,
  Message,
  StreamedMessagePart,
  ToolDescription as Tool,
} from '@moonshot-ai/core/llm/message';
import type { LlmTiming } from '@moonshot-ai/core/llm/response';
import type { TokenUsage } from '@moonshot-ai/core/llm/usage';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { LogContext } from '#/_base/log/log';

export type AgentLLMRequestLogFields = Readonly<LogContext>;

export type AgentLLMRequestSource =
  | {
      readonly type: 'turn';
      readonly turnId: number;
      readonly step?: number;
      readonly logFields?: AgentLLMRequestLogFields;
    }
  | {
      readonly type: 'operation';
      readonly turnId?: number;
      readonly requestKind?: string;
      readonly logFields?: AgentLLMRequestLogFields;
    };

export interface AgentLLMRequestFinish {
  message: AssistantMessage;
  usage: TokenUsage;
  model?: string | undefined;
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  providerMessageId?: string;
  timing?: LlmTiming;
  traceId?: string;
}

export type AgentLLMRequestPartHandler = (
  part: StreamedMessagePart,
) => void | Promise<void>;

export interface AgentLLMRequestOverrides {
  messages?: readonly Message[];
  tools?: readonly Tool[];
  systemPrompt?: string;
  source?: AgentLLMRequestSource;
  maxOutputSize?: number;
  usedContextTokens?: number;
  promptCacheProbe?: 'compaction';
  onAttemptRetry?: () => void;
}

export interface AgentLLMRequestAttemptFailure {
  readonly usage?: TokenUsage;
  readonly messageId?: string;
  readonly timing?: LlmTiming;
}

export interface AgentLLMRequestTask {
  readonly trace: LLMRequestTrace;
  readonly result: Promise<AgentLLMRequestFinish>;
  readonly attemptFailure?: () => AgentLLMRequestAttemptFailure | undefined;
}

export interface IAgentLLMRequesterService {
  readonly _serviceBrand: undefined;

  request(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): Promise<AgentLLMRequestFinish>;

  start(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): AgentLLMRequestTask;
}

export const IAgentLLMRequesterService = createDecorator<IAgentLLMRequesterService>(
  'agentLLMRequesterService',
);
