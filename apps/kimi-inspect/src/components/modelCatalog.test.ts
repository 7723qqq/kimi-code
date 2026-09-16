import { describe, expect, it } from 'vitest';

import type { ModelCatalogItem, ModelRecord, ProviderCatalogItem } from '../compat/v2';
import { formatContextSize, groupModelsByProvider } from './modelCatalog';

function model(model: string, provider: string): ModelCatalogItem {
  return { model, provider, max_context_size: 200_000 };
}

function provider(id: string, defaultModel?: string): ProviderCatalogItem {
  return {
    id,
    type: 'openai',
    has_api_key: true,
    status: 'connected',
    default_model: defaultModel,
  };
}

describe('groupModelsByProvider', () => {
  it('orders models under their listed provider', () => {
    const entries = groupModelsByProvider(
      [model('b/one', 'b'), model('a/one', 'a')],
      [provider('a'), provider('b')],
      {},
    );
    expect(entries.map((entry) => entry.item.model)).toEqual(['a/one', 'b/one']);
    expect(entries.map((entry) => entry.provider?.id)).toEqual(['a', 'b']);
  });

  it('prefers the raw record providerId over the model item provider', () => {
    const records: Record<string, ModelRecord> = {
      'a/one': { providerId: 'a', provider: 'a' },
    };
    // The catalog item reports no provider (the alias inherits the global
    // default); the record is what puts it under the listed provider.
    const entries = groupModelsByProvider(
      [{ model: 'a/one', provider: '', max_context_size: 1 }],
      [provider('a')],
      records,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.provider?.id).toBe('a');
  });

  it('keeps models whose group matches no listed provider', () => {
    const entries = groupModelsByProvider(
      [model('a/one', 'a'), model('ghost/one', 'ghost')],
      [provider('a')],
      {},
    );
    expect(entries.map((entry) => entry.item.model)).toEqual(['a/one', 'ghost/one']);
    expect(entries[1]!.provider).toBeUndefined();
  });

  it('drops nothing when no provider is listed', () => {
    const entries = groupModelsByProvider([model('a/one', 'a')], [], {});
    expect(entries.map((entry) => entry.item.model)).toEqual(['a/one']);
  });
});

describe('formatContextSize', () => {
  it('labels thousands, millions and the unknown case', () => {
    expect(formatContextSize(0)).toBe('—');
    expect(formatContextSize(512)).toBe('512 ctx');
    expect(formatContextSize(200_000)).toBe('200k ctx');
    expect(formatContextSize(1_000_000)).toBe('1M ctx');
    expect(formatContextSize(1_500_000)).toBe('1.5M ctx');
  });
});
