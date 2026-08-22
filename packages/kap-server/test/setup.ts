import { afterEach } from 'vitest';

import { drainQueryStoreDisposals, drainSessionIndexMirror } from '@moonshot-ai/agent-core-v2';

delete process.env['KIMI_CODE_EXPERIMENTAL_FLAG'];
for (const key of Object.keys(process.env)) {
  if (key.startsWith('KIMI_CODE_EXPERIMENTAL_')) {
    delete process.env[key];
  }
}

afterEach(async () => {
  await drainSessionIndexMirror();
  await drainQueryStoreDisposals();
});
