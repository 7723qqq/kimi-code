/**
 * `shellTools` domain (L4) — built-in shell tool registration contract.
 *
 * `IShellToolsService` is a marker: its implementation registers the built-in
 * Bash tool into the agent `IToolRegistry` on construction. Bound at Agent
 * scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IShellToolsService {
  readonly _serviceBrand: undefined;
}

export const IShellToolsService: ServiceIdentifier<IShellToolsService> =
  createDecorator<IShellToolsService>('shellToolsService');
