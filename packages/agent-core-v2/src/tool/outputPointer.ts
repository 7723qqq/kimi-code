export type OutputUnit = 'chars' | 'bytes';

const UNIT_WORD: Readonly<Record<OutputUnit, string>> = {
  chars: 'characters',
  bytes: 'bytes',
};

export function outputUnitWord(unit: OutputUnit): string {
  return UNIT_WORD[unit];
}

export function formatOutputSize(unit: OutputUnit, value: number): string {
  return `output_size_${unit}: ${String(value)}`;
}

export function outputSizeLine(unit: OutputUnit, totalSize: number, preserved?: number): string {
  const size = formatOutputSize(unit, totalSize);
  if (preserved === undefined || preserved >= totalSize) return size;
  return `${size} (only the first ${String(preserved)} ${outputUnitWord(unit)} were preserved)`;
}

export const READ_OUTPUT_HINT =
  'next_step: Use Read with output_path to page through the saved output, or Grep to search it.';

export function outputNextStep(step: 'read' | 'task-output', taskId?: string): string {
  if (step === 'task-output') {
    return taskId === undefined
      ? 'next_step: Use TaskOutput with the task_id to query the task output.'
      : `next_step: Use TaskOutput(task_id="${taskId}") to query the task output.`;
  }
  return READ_OUTPUT_HINT;
}

export interface AppendedPointerInput {
  readonly path: string;
  readonly totalSize: number;
  readonly unit: OutputUnit;
  readonly preserved?: number;
  readonly hasMedia?: boolean;
}

export function renderAppendedPointer(input: AppendedPointerInput): string {
  const { path, totalSize, unit, preserved, hasMedia } = input;
  const word = outputUnitWord(unit);
  const partial = preserved !== undefined && preserved < totalSize;
  const headline = partial
    ? `[Per-line truncation occurred; only the first ${String(preserved)} ${word} (of ${String(totalSize)}) were saved to a file.`
    : hasMedia === true
      ? '[Per-line truncation occurred; the complete text output was saved to a file (media parts stay attached to this result).'
      : '[Per-line truncation occurred; the complete output was saved to a file.';
  return [headline, `output_path: ${path}`, `${READ_OUTPUT_HINT}]`].join('\n');
}

export type ReplacedPointerInput = {
  readonly path: string;
  readonly totalSize: number;
  readonly preserved: number;
  readonly maxSize: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly hasMedia?: boolean;
} & (
  | { readonly unit: 'chars'; readonly byteSize?: number }
  | { readonly unit: 'bytes'; readonly byteSize?: never }
);

export function renderReplacedPointer(input: ReplacedPointerInput): string {
  const { path, totalSize, unit, preserved, maxSize, toolName, toolCallId, byteSize, hasMedia } =
    input;
  const word = outputUnitWord(unit);
  const partial = preserved < totalSize;
  const headline = partial
    ? `Tool output exceeded ${String(maxSize)} ${word}; the first ${String(preserved)} ${word} (of ${String(totalSize)}) were saved to a file.`
    : hasMedia === true
      ? `Tool output exceeded ${String(maxSize)} ${word}; the full text output was saved to a file (media parts stay attached to this result).`
      : `Tool output exceeded ${String(maxSize)} ${word}; the full output was saved to a file.`;
  const lines = [
    headline,
    `tool_name: ${toolName}`,
    `tool_call_id: ${toolCallId}`,
    outputSizeLine(unit, totalSize, preserved),
  ];
  if (byteSize !== undefined) lines.push(formatOutputSize('bytes', byteSize));
  lines.push(`output_path: ${path}`, READ_OUTPUT_HINT);
  return lines.join('\n');
}

export interface UnpersistedPointerInput {
  readonly totalSize: number;
  readonly unit: OutputUnit;
  readonly maxSize: number;
  readonly toolName: string;
  readonly toolCallId: string;
}

export function renderUnpersistedPointer(input: UnpersistedPointerInput): string {
  const { totalSize, unit, maxSize, toolName, toolCallId } = input;
  return [
    `Tool output exceeded ${String(maxSize)} ${outputUnitWord(unit)} and could not be saved to a file; only this preview is available.`,
    `tool_name: ${toolName}`,
    `tool_call_id: ${toolCallId}`,
    formatOutputSize(unit, totalSize),
  ].join('\n');
}
