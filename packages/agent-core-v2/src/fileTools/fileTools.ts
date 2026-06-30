/**
 * `fileTools` domain (L4) — built-in file tool registration contract.
 *
 * `IFileToolsService` is a marker: its implementation registers the built-in
 * file tools (Read / Write / Edit / Grep / Glob) into the agent `IToolRegistry`
 * on construction. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IFileToolsService {
  readonly _serviceBrand: undefined;
}

export const IFileToolsService: ServiceIdentifier<IFileToolsService> =
  createDecorator<IFileToolsService>('fileToolsService');
