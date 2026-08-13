import { it } from 'vitest';

import { createKimiHarnessV2 } from '../src/index';

it('real request: capture usage across two turns', async () => {
  const harness = createKimiHarnessV2({
    homeDir: 'C:/Users/Administrator/.kimi-code',
    identity: { productName: 'kimi-code-cli', version: '0.36.0', platform: 'kimi_code_cli' },
  });
  const session = await harness.createSession({
    id: `cache_verify_${Date.now()}`,
    workDir: 'C:/Users/Administrator',
  });
  const seen = new Set<string>();
  session.onEvent((event: unknown) => {
    const e = event as { type?: string; usage?: unknown };
    if (e.type !== undefined) {
      if (!seen.has(e.type)) {
        seen.add(e.type);
        console.log(`EVENT TYPE: ${e.type}`);
      }
      if (e.type.includes('step') || e.type.includes('usage') || e.type.includes('turn')) {
        console.log(`EVENT ${e.type}: ${JSON.stringify(e).slice(0, 800)}`);
      }
    }
  });
  await session.prompt('请只回答：1+1等于几');
  console.log('--- turn 1 done ---');
  await session.prompt('请只回答：2+2等于几');
  console.log('--- turn 2 done ---');
  const usage = await session.getUsage();
  console.log(`SESSION USAGE: ${JSON.stringify(usage)}`);
  await harness.close();
}, 120_000);
