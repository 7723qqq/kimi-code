import { describe, expect, it } from 'vitest';

import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';

import { createTestAgent } from './test/harness';

describe('tmp tools dump', () => {
  it('dumps the llm tools snapshot', async () => {
    const ctx = createTestAgent();
    try {
      const wire = ctx.get(IAgentWireService) as IWireService;
      ctx.mockNextResponse({ type: 'text', text: 'hi' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await ctx.untilTurnEnd();
      const record = ctx.recordHistory.find((r) => r.type === 'llm.tools_snapshot') as
        | { tools: Array<{ name: string; description?: string }>; hash: string }
        | undefined;
      const { writeFileSync } = await import('node:fs');
      writeFileSync('/tmp/current-tools.json', JSON.stringify(record, null, 2));
      // eslint-disable-next-line no-console
      console.log('HASH', record?.hash);
    } finally {
      await ctx.dispose();
    }
    expect(true).toBe(true);
  });
});
