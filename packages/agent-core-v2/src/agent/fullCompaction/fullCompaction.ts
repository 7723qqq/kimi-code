import type {
  CompactionResult,
  CompactionSource,
} from './types';
import { createDecorator } from "#/_base/di/instantiation";
import type { Hooks } from '#/hooks';

export type FullCompactionCompleteData = Omit<CompactionResult, 'summary' | 'contextSummary'>;

export interface CompactInput {
  readonly source: CompactionSource;
  readonly instruction?: string;
}

export interface FullCompactionWillCompactContext {
  readonly abortController: AbortController;
  readonly promise: Promise<CompactionResult>;
  readonly trigger: CompactionSource;
  readonly tokenCount: number;
}

export interface FullCompactionDidCompactContext {
  readonly trigger: CompactionSource;
  readonly estimatedTokenCount: number;
}

export interface IAgentFullCompactionService {
  readonly _serviceBrand: undefined;

  readonly compacting: FullCompactionWillCompactContext | null;
  begin(input: CompactInput): boolean;

  readonly hooks: Hooks<{
    onWillCompact: FullCompactionWillCompactContext;
  }>;
}

export const IAgentFullCompactionService = createDecorator<IAgentFullCompactionService>('agentFullCompactionService');
