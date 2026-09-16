/**
 * Pure data shaping for the Model Catalog view: the provider grouping the left
 * list renders and the context-size label. Kept out of the component so the
 * grouping rules — which read two different server projections — are testable
 * without a DOM.
 */

import type { ModelCatalogItem, ModelRecord, ProviderCatalogItem } from '../compat/v2';
import { t } from '../i18n';

export interface ModelCatalogEntry {
  readonly item: ModelCatalogItem;
  readonly provider?: ProviderCatalogItem;
}

/**
 * Flatten the provider grouping into one ordered model list: listed providers
 * first (in their own order), then models whose group matches no listed
 * provider. The group key prefers the raw record's `providerId`, because
 * `listModels` reports the alias's declared provider and leaves it empty for
 * an alias that inherits the global default.
 */
export function groupModelsByProvider(
  items: readonly ModelCatalogItem[],
  providers: readonly ProviderCatalogItem[],
  records: Readonly<Record<string, ModelRecord>>,
): ModelCatalogEntry[] {
  const groupKeyOf = (item: ModelCatalogItem): string => {
    const record = records[item.model];
    return record?.providerId ?? record?.provider ?? item.provider;
  };
  const byGroup = new Map<string, ModelCatalogItem[]>();
  for (const item of items) {
    const key = groupKeyOf(item);
    const group = byGroup.get(key) ?? [];
    group.push(item);
    byGroup.set(key, group);
  }
  const listedIds = new Set(providers.map((p) => p.id));
  const extraGroups = [...byGroup.keys()].filter((key) => !listedIds.has(key));
  return [
    ...providers.flatMap((provider) =>
      (byGroup.get(provider.id) ?? []).map((item) => ({ item, provider }) as const),
    ),
    ...extraGroups.flatMap((key) => (byGroup.get(key) ?? []).map((item) => ({ item }) as const)),
  ];
}

export function formatContextSize(size: number): string {
  if (size <= 0) return t('modelCatalog.contextSizeUnknown');
  if (size >= 1_000_000) {
    const millions = size / 1_000_000;
    return t('modelCatalog.contextSizeM', {
      size: millions.toFixed(Number.isInteger(millions) ? 0 : 1),
    });
  }
  if (size >= 1_000) return t('modelCatalog.contextSizeK', { size: Math.round(size / 1_000) });
  return t('modelCatalog.contextSize', { size });
}
