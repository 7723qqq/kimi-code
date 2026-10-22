import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'bun:test';

// Audit a37/F3 + a37/F4 — the projector now reports malformed records it
// skipped, and `/context` merges them into the response `warnings`. The spec's
// risk note requires them to be visible in the UI; this pins the wiring in
// ContextTab (the strip mirrors WireTab's) and the API contract that feeds it.
const SRC = resolve(import.meta.dirname, '../src');

describe('context warnings are surfaced in the UI (a37/F3 + a37/F4)', () => {
  it('ContextTab renders the warnings returned by /context', async () => {
    const tab = await readFile(resolve(SRC, 'components/context/ContextTab.tsx'), 'utf8');

    expect(tab).toContain("const warnings = ctx?.warnings ?? [];");
    expect(tab).toMatch(/\{warnings\.length > 0 \?/);
    expect(tab).toContain("t(warnings.length > 1 ? 'wire.warnings' : 'wire.warning'");
  });

  it('the /context response type carries warnings', async () => {
    const types = await readFile(resolve(SRC, 'types.ts'), 'utf8');

    expect(types).toMatch(/interface ContextResponse \{[\s\S]*?warnings\?: string\[\];/);
  });
});
