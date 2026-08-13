import { it } from 'vitest';

import { LocalFetchURLProvider } from '#/app/web/providers/local-fetch-url';

it('reproduce FetchURL failure', async () => {
  const provider = new LocalFetchURLProvider();
  for (const url of [
    'https://en.wikipedia.org/wiki/Mersenne_prime',
    'https://example.com',
  ]) {
    try {
      const result = await provider.fetch(url);
      console.log(`OK ${url}: ${result.kind} len=${result.content.length}`);
    } catch (error) {
      console.log(`FAIL ${url}: ${error instanceof Error ? error.message : String(error)}`);
      console.log(`  stack: ${error instanceof Error ? (error.stack ?? '').split('\n').slice(0, 4).join('\n  ') : ''}`);
    }
  }
}, 60_000);
