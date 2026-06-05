/**
 * Helper for module-init contexts that prefer the registry pattern over
 * `defaultServicesModule()` (e.g. side-effect-on-import wiring). Daemon-side
 * code should use `defaultServicesModule()` instead — it's the canonical
 * wiring strategy for W3+. This helper exists only because the existing
 * `registerSingleton` registry is the established pattern in agent-core's
 * DI README; we don't ship it from the package barrel.
 */

import { InstantiationType, registerSingleton } from '@moonshot-ai/agent-core';

import { HarnessBridge, IHarnessBridge } from './harness-bridge';

export function registerHarnessBridge(): void {
  registerSingleton(IHarnessBridge, HarnessBridge, InstantiationType.Eager);
}
