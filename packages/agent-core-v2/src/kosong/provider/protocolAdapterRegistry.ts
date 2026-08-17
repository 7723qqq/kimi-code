/**
 * `kosong/provider` domain — the single production implementation of
 * `IProtocolAdapterRegistry`.
 *
 * This is the one resolution point for "(protocol, providerType) → which base
 * + which traits" and the single construction point for composed
 * ChatProviders:
 *
 *  - `resolveAdapterIdentity` — the two branches: a `(providerType,
 *    protocol)` pair registration → the protocol as base with that
 *    registration's traits; no pair registration (unregistered vendor, no
 *    providerType, or the vendor does not run over this protocol) → the
 *    protocol itself as base with no vendor traits. The config
 *    `defaultHeaders` synthetic trait is ALWAYS appended last, so config
 *    headers win header aggregation; it declares no per-request hooks, so it
 *    can never shadow a real trait hook in composition.
 *  - `createChatProvider` — re-binds every resolved trait's context to the
 *    full adapter config (identity resolution knows only
 *    `(protocol, providerType)`; composition needs the real config) and
 *    delegates to the registered base's contrib factory.
 *  - `resolveCapability` — the fixed fallback chain: trait capability hooks
 *    (last declarer wins) → the base's own catalog → `UNKNOWN_CAPABILITY`.
 *
 * Bound at App scope, eager.
 */

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { ModelCapability } from '#/kosong/contract/capability';
import { ChatProviderError } from '#/kosong/contract/errors';
import type { ChatProvider } from '#/kosong/contract/provider';
import {
  IProtocolAdapterRegistry,
  type ExplainedCapability,
  type Protocol,
  type ProtocolAdapterConfig,
} from '#/kosong/protocol/protocol';
import {
  getProtocolBase,
  listProtocolBases,
  type ProtocolBaseId,
  type ResolvedAdapterIdentity,
} from '#/kosong/protocol/protocolBase';
import type { ProtocolTrait, ResolvedTrait, TraitContext } from '#/kosong/protocol/protocolTrait';

import { getProviderDefinition, hasProviderDefinition } from './providerDefinition';

const CONFIG_DEFAULT_HEADERS_TRAIT: ProtocolTrait = {
  defaultHeaders: (ctx) =>
    ctx.config.defaultHeaders === undefined ? undefined : { ...ctx.config.defaultHeaders },
};

// One-shot warnings for unregistered (providerType, protocol) pairs, so a
// misconfigured vendor silently degrading to the bare protocol base is
// visible without spamming every request.
const warnedUnregisteredPairs = new Set<string>();

function warnUnregisteredProviderPair(providerType: string, protocol: Protocol): void {
  const key = `${providerType}@${protocol}`;
  if (warnedUnregisteredPairs.has(key)) return;
  warnedUnregisteredPairs.add(key);
  console.warn(
    `[kosong] provider '${providerType}' has no registered definition for protocol '${protocol}'; ` +
      'falling back to the bare protocol base (no vendor traits). ' +
      'Check the provider type and protocol configuration.',
  );
}

export class ProtocolAdapterRegistry implements IProtocolAdapterRegistry {
  declare readonly _serviceBrand: undefined;

  supportedProtocols(): readonly Protocol[] {
    return listProtocolBases().map((base) => base.id);
  }

  resolveAdapterIdentity(protocol: Protocol, providerType?: string): ResolvedAdapterIdentity {
    const definition =
      providerType === undefined ? undefined : getProviderDefinition(providerType, protocol);
    // Warn only when the vendor is KNOWN but this protocol pair is missing —
    // that is a real misconfiguration (e.g. kimi configured over
    // google-genai). A completely unknown providerType is the supported
    // "unregistered vendor" branch (custom relays, Ollama, …) and degrades
    // to the bare protocol base by design, so it must not warn.
    if (providerType !== undefined && definition === undefined && hasProviderDefinition(providerType)) {
      warnUnregisteredProviderPair(providerType, protocol);
    }
    const baseId: ProtocolBaseId = protocol;
    const traits: readonly ProtocolTrait[] = definition?.traits ?? [];

    // Identity resolution knows only (protocol, providerType); the model name
    // is not available here, so trait hooks must read the model name from
    // their `modelName` argument (e.g. `capability(modelName, ctx)`) rather
    // than from `ctx.config.modelName`, which is empty at this stage.
    const context: TraitContext = {
      config: { protocol, providerType, modelName: '' },
      providerId: providerType,
    };
    const resolved: ResolvedTrait[] = traits.map((trait) => ({ trait, context }));
    resolved.push({ trait: CONFIG_DEFAULT_HEADERS_TRAIT, context });
    return { baseId, traits: resolved };
  }

  resolveCapability(protocol: Protocol, modelName: string, providerType?: string): ModelCapability {
    return this.explainCapability(protocol, modelName, providerType).capability;
  }

  explainCapability(
    protocol: Protocol,
    modelName: string,
    providerType?: string,
  ): ExplainedCapability {
    const identity = this.resolveAdapterIdentity(protocol, providerType);
    let traitCapability: ModelCapability | undefined;
    for (const { trait, context } of identity.traits) {
      if (trait.capability === undefined) continue;
      const capability = trait.capability(modelName, context);
      if (capability !== undefined) {
        traitCapability = capability;
      }
    }
    if (traitCapability !== undefined) {
      return {
        capability: traitCapability,
        source: {
          kind: 'builtin',
          detail: `trait capability hook (provider '${providerType ?? 'unregistered'}')`,
        },
      };
    }

    const baseCapability = getProtocolBase(identity.baseId)?.capability?.(modelName);
    if (baseCapability !== undefined) {
      return {
        capability: baseCapability,
        source: { kind: 'builtin', detail: `protocol base '${identity.baseId}' catalog` },
      };
    }
    return {
      capability: UNKNOWN_CAPABILITY,
      source: { kind: 'none', detail: 'no capability source knew this model' },
    };
  }

  createChatProvider(config: ProtocolAdapterConfig): ChatProvider {
    const identity = this.resolveAdapterIdentity(config.protocol, config.providerType);
    const traits: ResolvedTrait[] = identity.traits.map(({ trait }) => ({
      trait,
      context: { config, providerId: config.providerType },
    }));
    const base = getProtocolBase(identity.baseId);
    if (base === undefined) {
      throw new ChatProviderError(
        `No protocol base registered for '${identity.baseId}'. Import the base's contrib module first.`,
      );
    }
    return base.createChatProvider({ config, traits });
  }
}

registerScopedService(
  LifecycleScope.App,
  IProtocolAdapterRegistry,
  ProtocolAdapterRegistry,
  ScopeActivation.OnScopeCreated,
  'provider',
);
