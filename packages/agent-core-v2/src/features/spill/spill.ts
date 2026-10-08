import { createDecorator } from '#/_base/di/instantiation';

export type SpillLocator = string & { readonly __spillLocator: unique symbol };

export function SpillLocator(locator: string): SpillLocator {
  return locator as SpillLocator;
}

export interface SpillOwner {
  readonly sessionId: string;
}

export interface SpillSource {

  readonly toolName: string;

  readonly callId: string;

  readonly label: string;
}

export interface SaveTextSpill {
  readonly owner: SpillOwner;
  readonly source: SpillSource;

  readonly suggestedName: string;

  readonly content: string;
}

export interface SpillRef {
  readonly locator: SpillLocator;
  readonly bytes: number;
  readonly retrievalHint: string;
}

export interface ISpillService {
  readonly _serviceBrand: undefined;

  saveText(input: SaveTextSpill): Promise<SpillRef>;

  readText(locator: SpillLocator): Promise<string | null>;
}

export const ISpillService = createDecorator<ISpillService>('spillService');
