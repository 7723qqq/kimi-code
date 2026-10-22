import { describe, expect, it } from 'bun:test';

import { estimateTokens, estimateTokensForJson } from '../src/tokens';

describe('json token multiplier', () => {
  it('applies a 1.3 multiplier to json-shaped content', () => {
    const json = '{"path":"src/parser.ts","startLine":10,"endLine":42,"encoding":"utf-8"}';
    const ratio = estimateTokensForJson(json) / estimateTokens(json);
    expect(ratio).toBeGreaterThanOrEqual(1.25);
    expect(ratio).toBeLessThanOrEqual(1.35);
  });

  it('is inert for non-json text because callers choose the variant', () => {
    const prose = 'the parser drops trailing newlines';
    expect(estimateTokensForJson(prose)).toBeGreaterThanOrEqual(estimateTokens(prose));
  });
});
