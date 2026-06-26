import { createDecorator } from "#/_base/di";

export interface ContextSizeStatus {
  readonly contextTokens: number;
  readonly contextTokensWithPending: number;
}

export interface IContextSizeService {
  readonly _serviceBrand: undefined;

  getStatus(): ContextSizeStatus;
  measured(length: number, tokens: number): void;
}

export const IContextSizeService =
  createDecorator<IContextSizeService>('agentContextSizeService');
