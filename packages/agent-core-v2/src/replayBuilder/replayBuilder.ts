import { createDecorator } from "#/_base/di";
import type { ContextMessage } from '#/contextMemory';
import type { WireRecord } from "#/wireRecord";
import type { AgentReplayRecord, AgentReplayRecordPayload } from './types';

export interface ReplayRangeOptions {
  readonly start?: number;
  readonly count?: number;
}

export interface ReplayBuilderServiceOptions {
  readonly range?: ReplayRangeOptions;
}

export interface IAgentReplayBuilderService {
  readonly _serviceBrand: undefined;

  postRestoring: boolean;
  captureLiveRecords: boolean;

  push(record: AgentReplayRecordPayload): void;
  patchLast<T extends AgentReplayRecord['type']>(
    type: T,
    patch: Partial<Extract<AgentReplayRecord, { type: T }>>,
  ): void;
  removeLastMessages(removedMessages: ReadonlySet<ContextMessage>): void;
  finishRestoringRecord(record: WireRecord): boolean;
  buildResult(): readonly AgentReplayRecord[];
}

export const IAgentReplayBuilderService = createDecorator<IAgentReplayBuilderService>(
  'agentReplayBuilderService',
);
