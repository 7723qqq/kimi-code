/**
 * `config` test stubs — shared config collaborators for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../config/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { IConfigRegistry, IConfigService } from '#/config/config';
import { ConfigRegistry } from '#/config/configService';
import { IAtomicTomlDocumentStore, TomlAtomicDocumentStore } from '#/storage';

/**
 * Register the default config collaborators: a real `ConfigRegistry` plus an
 * empty `IConfigService` placeholder, and the real TOML atomic-document store
 * (so tests exercising the real `ConfigService` only need to supply an
 * `IStorageService` backend and override the `IConfigService` placeholder).
 */
export function registerConfigServices(reg: ServiceRegistration): void {
  reg.defineInstance(IConfigRegistry, new ConfigRegistry());
  reg.definePartialInstance(IConfigService, {});
  reg.define(IAtomicTomlDocumentStore, TomlAtomicDocumentStore);
}
