/**
 * Module-global service registry. Modules (or top-level files) register their
 * service implementations at import-time via `registerSingleton`; the daemon
 * bootstrap then seeds the root `ServiceCollection` from
 * `getSingletonServiceDescriptors()`.
 *
 * Modelled after VSCode's `extensions.ts` — same shape, same intent.
 */

import { InstantiationType, SyncDescriptor } from './descriptors';
import type { ServiceIdentifier } from './instantiation';

interface RegistryEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  descriptor: SyncDescriptor<any>;
  instantiationType: InstantiationType;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _registry = new Map<ServiceIdentifier<any>, RegistryEntry>();

/**
 * Register a service implementation under its identifier. Typically called
 * at module top-level. Re-registering the same id throws — a deliberate
 * choice so module load order accidents fail loud, not silent.
 */
export function registerSingleton<T>(
  id: ServiceIdentifier<T>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctor: new (...args: any[]) => T,
  instantiationType: InstantiationType = InstantiationType.Eager,
): void {
  if (_registry.has(id)) {
    throw new Error(`Service '${String(id)}' is already registered`);
  }
  _registry.set(id, {
    descriptor: new SyncDescriptor(ctor),
    instantiationType,
  });
}

/**
 * Snapshot the registry as a list suitable for `ServiceCollection`
 * construction.
 *
 * Shape: `[id, descriptor, instantiationType][]`. The bootstrap layer is
 * expected to project this into `[id, descriptor]` tuples for
 * `ServiceCollection` and stash the `instantiationType` on the descriptor if
 * delayed-instantiation support is wired in later.
 */
export function getSingletonServiceDescriptors(): ReadonlyArray<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [ServiceIdentifier<any>, SyncDescriptor<any>, InstantiationType]
> {
  return Array.from(
    _registry,
    ([id, { descriptor, instantiationType }]) => [id, descriptor, instantiationType] as const,
  );
}

/**
 * Test-only escape hatch: empty the registry. Real code must never call this
 * — module-load registrations are intended to be permanent for the lifetime
 * of the process.
 */
export function _clearRegistryForTests(): void {
  _registry.clear();
}
