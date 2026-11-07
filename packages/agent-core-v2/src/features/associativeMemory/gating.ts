export type GatingMode = 'encode' | 'retrieve' | 'consolidate';

export interface GatingInput {
  readonly sameCueRepeated: boolean;
  readonly unstableRecall: boolean;
  readonly newScopeOrTopic: boolean;
  readonly positiveFeedback: boolean;
}

export interface GatingResult {
  readonly mode: GatingMode;
  readonly expectedUncertainty: number;
  readonly unexpectedUncertainty: number;
  readonly boost: number;
}

export function classifyGating(input: GatingInput): GatingResult {
  const expectedUncertainty = Number(input.sameCueRepeated && input.unstableRecall);
  const unexpectedUncertainty = Number(input.newScopeOrTopic);
  let mode: GatingMode = 'retrieve';
  if (unexpectedUncertainty === 1) mode = 'encode';
  else if (expectedUncertainty === 1 && !input.positiveFeedback) mode = 'consolidate';
  const boost = input.positiveFeedback ? 1.2 : unexpectedUncertainty === 1 ? 1.1 : 1;
  return { mode, expectedUncertainty, unexpectedUncertainty, boost };
}
