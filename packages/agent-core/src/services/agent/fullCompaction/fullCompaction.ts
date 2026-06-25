import type {
  CompactionBeginData,
  CompactionResult,
  CompactionSource,
} from '../../../agent/compaction';
import { createDecorator } from '../../../di';

export interface CompactInput {
  readonly source: CompactionSource;
  readonly instruction?: string;
  readonly customInstruction?: string;
  readonly signal?: AbortSignal;
}

export interface IFullCompaction {
  readonly isCompacting: boolean;

  begin(input: CompactInput): boolean;
  cancel(): void;
  handleOverflowError(signal: AbortSignal, error: unknown, turnId?: number): Promise<void>;
}

declare module '../types' {
  interface WireRecordMap {
    'full_compaction.begin': CompactionBeginData;
    'full_compaction.cancel': {};
    'full_compaction.complete': {};
    // Informational marker emitted alongside the compaction-summary
    // `context.splice` that actually folds history. It carries the compaction
    // result for UI/transcript consumers and has no resumer (restore is driven
    // by the splice), matching the legacy `context.apply_compaction` event.
    'context.apply_compaction': CompactionResult;
  }
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IFullCompaction = createDecorator<IFullCompaction>('agentFullCompactionService');
