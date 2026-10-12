import type {
  KimiConfig,
  KimiConfigPatch,
  ModelAlias,
  ProviderConfig,
} from '@moonshot-ai/kimi-code-sdk';

/**
 * The write boundary every provider mutation that REPLACES a record goes
 * through.
 *
 * Such a write cannot be one `setConfig`: the patch deep-merges, so it can add
 * and overwrite keys but never delete one, and the aliases a dropped model row
 * (or a renamed provider id) leaves behind would survive it. The write is
 * therefore a pair — `removeProvider` cascades the old records away, then the
 * patch rebuilds them.
 *
 * Persisted as two calls that pair is not atomic, and a process exit between
 * them lands in the worst state available: the provider and every one of its
 * aliases are gone from config.toml and the edited replacement was never
 * written. A host that can land several sections in ONE write
 * (`replaceConfigSections`) closes that window — the removal is folded into the
 * patch in memory (`removeProviderFromConfig`) and the complete resulting
 * records are written once. Hosts without the capability keep the two-call
 * pairing, each call atomic on its own; that is the v1 behaviour, and
 * `tui/controllers/auth-flow.ts` splits the same way for the provider refresh
 * orchestrator.
 *
 * `setConfig` and `replaceConfigSections` do NOT agree on what an `undefined`
 * section means — the engine's `setConfig` skips that domain, `replaceSections`
 * clears it — so the two shapes are built separately here instead of one being
 * derived from the other.
 */

/**
 * The complete `providers` / `models` / default-pointer values a write must
 * leave behind, as `replaceConfigSections` reads them: `undefined` CLEARS the
 * section, so a pointer that has to survive carries the value it already has.
 */
export interface ProviderWriteSections {
  readonly providers: Record<string, ProviderConfig>;
  readonly models: Record<string, ModelAlias>;
  readonly defaultModel?: string;
  readonly defaultProvider?: string;
}

/** One provider write, in both shapes the hosts accept. */
export interface ProviderWrite {
  /** The merge patch — the whole write on a host without atomic sections. */
  readonly patch: KimiConfigPatch;
  /** The same write as complete sections, for the atomic path. */
  readonly sections: ProviderWriteSections;
  /** The record to cascade away first; absent when nothing is replaced. */
  readonly removeProviderId?: string;
}

export interface ProviderWriteHarness {
  removeProvider(providerId: string): Promise<KimiConfig>;
  setConfig(patch: KimiConfigPatch): Promise<KimiConfig>;
  supportsAtomicSectionReplace(): boolean;
  replaceConfigSections(sections: Record<string, unknown>): Promise<void>;
}

/**
 * The sections a whole config carries. Callers that mutate a config in place
 * (`applyCatalogProvider`) hand the result here instead of describing the write
 * twice.
 */
export function providerSectionsOf(config: KimiConfig): ProviderWriteSections {
  return {
    providers: config.providers,
    models: config.models ?? {},
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider,
  };
}

/**
 * Persists one provider write as a single atomic section replace where the host
 * supports it, and as the legacy `removeProvider` + `setConfig` pair where it
 * does not.
 */
export async function persistProviderWrite(
  harness: ProviderWriteHarness,
  write: ProviderWrite,
): Promise<void> {
  if (harness.supportsAtomicSectionReplace()) {
    // Every key is passed even when its value is `undefined`: that is how a
    // dangling default pointer is cleared rather than left pointing at an alias
    // the write just removed.
    await harness.replaceConfigSections({
      providers: write.sections.providers,
      models: write.sections.models,
      defaultModel: write.sections.defaultModel,
      defaultProvider: write.sections.defaultProvider,
    });
    return;
  }
  if (write.removeProviderId !== undefined) {
    await harness.removeProvider(write.removeProviderId);
  }
  await harness.setConfig(write.patch);
}
