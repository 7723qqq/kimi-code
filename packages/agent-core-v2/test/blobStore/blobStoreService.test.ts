import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContentPart } from '@moonshot-ai/kosong';
import { LifecycleScope } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IAgentBlobStoreService } from '#/blobStore';
import { IBlobStorage, InMemoryStorageService } from '#/storage';

function makeLargeDataUri(mimeType = 'image/png'): { uri: string; payload: string } {
  // The default threshold is 4096 base64 characters.
  const payload = 'A'.repeat(5000);
  return { uri: `data:${mimeType};base64,${payload}`, payload };
}

function makeSmallDataUri(mimeType = 'image/png'): { uri: string; payload: string } {
  const payload = 'AQID';
  return { uri: `data:${mimeType};base64,${payload}`, payload };
}

describe('AgentBlobStoreService', () => {
  let host: ReturnType<typeof createScopedTestHost>;

  beforeEach(() => {
    host = createScopedTestHost([stubPair(IBlobStorage, new InMemoryStorageService())]);
  });

  afterEach(() => {
    host.dispose();
  });

  function getBlobStore(): IAgentBlobStoreService {
    const agent = host.app.createChild(LifecycleScope.Agent, 'test-agent');
    return agent.accessor.get(IAgentBlobStoreService);
  }

  it('leaves small data URIs unchanged', async () => {
    const store = getBlobStore();
    const { uri } = makeSmallDataUri();
    const parts: ContentPart[] = [{ type: 'image_url', imageUrl: { url: uri } }];

    const result = await store.offloadParts(parts);

    expect(result).toBe(parts);
    expect((result[0]! as { imageUrl: { url: string } }).imageUrl.url).toBe(uri);
  });

  it('offloads large data URIs to blobref URIs', async () => {
    const store = getBlobStore();
    const { uri, payload } = makeLargeDataUri();
    const parts: ContentPart[] = [{ type: 'image_url', imageUrl: { url: uri } }];

    const result = await store.offloadParts(parts);

    expect(result).not.toBe(parts);
    const newUrl = (result[0]! as { imageUrl: { url: string } }).imageUrl.url;
    expect(store.isBlobRef(newUrl)).toBe(true);
    expect(newUrl.startsWith('blobref:image/png;')).toBe(true);

    const backend = host.app.accessor.get(IBlobStorage);
    const keys = await backend.list('blobs');
    expect(keys).toHaveLength(1);
    expect(Buffer.from((await backend.read('blobs', keys[0]!))!).toString('base64')).toBe(payload);
  });

  it('rehydrates blobref URIs back to data URIs', async () => {
    const store = getBlobStore();
    const { uri } = makeLargeDataUri();
    const parts: ContentPart[] = [{ type: 'image_url', imageUrl: { url: uri } }];

    const offloaded = await store.offloadParts(parts);
    const rehydrated = await store.rehydrateParts(offloaded);

    expect((rehydrated[0]! as { imageUrl: { url: string } }).imageUrl.url).toBe(uri);
  });

  it('rehydrates only blobref URLs and leaves other URLs alone', async () => {
    const store = getBlobStore();
    const { uri: largeUri } = makeLargeDataUri();
    const { uri: smallUri } = makeSmallDataUri();
    const parts: ContentPart[] = [
      { type: 'image_url', imageUrl: { url: largeUri } },
      { type: 'audio_url', audioUrl: { url: smallUri } },
    ];

    const offloaded = await store.offloadParts(parts);
    expect(store.isBlobRef((offloaded[0]! as { imageUrl: { url: string } }).imageUrl.url)).toBe(true);
    expect((offloaded[1]! as { audioUrl: { url: string } }).audioUrl.url).toBe(smallUri);

    const rehydrated = await store.rehydrateParts(offloaded);
    expect((rehydrated[0]! as { imageUrl: { url: string } }).imageUrl.url).toBe(largeUri);
    expect((rehydrated[1]! as { audioUrl: { url: string } }).audioUrl.url).toBe(smallUri);
  });

  it('replaces missing blobs with a placeholder', async () => {
    const store = getBlobStore();
    const parts: ContentPart[] = [
      { type: 'image_url', imageUrl: { url: 'blobref:image/png;deadbeef' } },
    ];

    const result = await store.rehydrateParts(parts);

    expect((result[0]! as { imageUrl: { url: string } }).imageUrl.url).toBe('[media missing]');
  });

  it('is idempotent across offload/rehydrate cycles', async () => {
    const store = getBlobStore();
    const { uri } = makeLargeDataUri();
    const parts: ContentPart[] = [{ type: 'image_url', imageUrl: { url: uri } }];

    const first = await store.offloadParts(parts);
    const second = await store.offloadParts(first);

    expect((second[0]! as { imageUrl: { url: string } }).imageUrl.url).toBe(
      (first[0]! as { imageUrl: { url: string } }).imageUrl.url,
    );
  });
});
