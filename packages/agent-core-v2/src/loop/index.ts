/**
 * `loop` domain barrel — re-exports the stateless loop facade and scoped
 * service contract/implementation.
 */

export type {
  AfterStepHook,
  AfterStepResult,
  BeforeStepResult,
  BeforeStepHook,
  LoopHooks,
  LoopAfterStepContext,
  LoopStepHookContext,
  LoopStepStopReason,
  LoopStoppedStepContext,
  LoopTerminalStepStopReason,
  LoopTurnStopReason,
  StopReason,
  RecordStepUsageContext,
  RecordStepUsageResult,
  ShouldContinueAfterStopHook,
  ShouldContinueAfterStopResult,
  LoopMessageBuilder,
  ToolExecutionHookContext,
  ResolvedToolExecutionHookContext,
  AuthorizeToolExecutionResult,
  PrepareToolExecutionResult,
  TurnResult,
} from './types';

export type {
  CreateLoopEventDispatcherInput,
  LoopContentPartEvent,
  LoopRecordedEvent,
  LoopStepBeginEvent,
  LoopStepEndEvent,
  LoopStepRetryingEvent,
  LoopLiveOnlyEvent,
  LoopEvent,
  LoopInterruptReason,
  LoopLiveEventEmitter,
  LoopEventDispatcher,
  LoopTextDeltaEvent,
  LoopThinkingDeltaEvent,
  LoopToolCallDeltaEvent,
  LoopToolCallEvent,
  LoopToolProgressEvent,
  LoopToolResultEvent,
  LoopTurnInterruptedEvent,
} from './events';
export { createLoopEventDispatcher } from './events';

export type {
  LLM,
  LLMChatParams,
  LLMChatResponse,
  LLMRequestLogFields,
  LLMStreamTiming,
  ToolCallDelta,
} from './llm';

export { runTurn } from './run-turn';
export type { RunTurnInput } from './run-turn';

export * from './loop';
export * from './loopService';
