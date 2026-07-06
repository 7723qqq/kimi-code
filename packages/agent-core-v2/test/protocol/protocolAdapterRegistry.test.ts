/**
 * `protocol` domain tests — covers the adapter registry's kosong config
 * mapping.
 */

import { describe, expect, it } from 'vitest';

import { ProtocolAdapterRegistry } from '#/app/protocol/protocolAdapterRegistry';

describe('ProtocolAdapterRegistry', () => {
  it('maps adapter defaultHeaders into the Kimi provider defaults', () => {
    const provider = new ProtocolAdapterRegistry().createChatProvider({
      protocol: 'kimi',
      baseUrl: 'https://example.test/v1',
      modelName: 'wire-name',
      apiKey: 'sk',
      defaultHeaders: { 'X-Test': '1' },
    });

    expect(Reflect.get(provider, '_defaultHeaders')).toEqual({ 'X-Test': '1' });
  });
});
