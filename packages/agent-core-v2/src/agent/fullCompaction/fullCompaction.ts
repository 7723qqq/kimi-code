import type {
  CompactionResult,
  CompactionSource,
} from './types';
import { createDecorator } from "#/_base/di";

export type FullCompactionCompleteData = Omit<CompactionResult, 'summary'>;

export interface CompactInput {
  readonly source: CompactionSource;
  readonly instruction?: string;
  readonly customInstruction?: string;
  readonly signal?: AbortSignal;
}

export interface IAgentFullCompactionService {
  readonly _serviceBrand: undefined;
  readonly isCompacting: boolean;

  begin(input: CompactInput): boolean;
  cancel(): void;
}

export const IAgentFullCompactionService = createDecorator<IAgentFullCompactionService>('agentFullCompactionService');
