import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

import type { LspHover, LspLocation, LspPosition } from './protocol';

export type LspOperation = 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover';

export interface LspQueryRequest {
  readonly operation: LspOperation;
  readonly filePath: string;
  readonly position: LspPosition;
  readonly workspaceRoot: string;
}

export interface LspProviderQuery extends LspQueryRequest {
  readonly languageId: string;
}

export type LspQueryResult =
  | { readonly kind: 'locations'; readonly locations: readonly LspLocation[] }
  | { readonly kind: 'hover'; readonly hover: LspHover | null };

export interface LspProvider {
  readonly id: string;
  readonly extensionToLanguage: Readonly<Record<string, string>>;
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>;
}

export interface ILspService {
  readonly _serviceBrand: undefined;

  registerProvider(provider: LspProvider): IDisposable;

  query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>;
}

export const ILspService: ServiceIdentifier<ILspService> =
  createDecorator<ILspService>('lspService');
