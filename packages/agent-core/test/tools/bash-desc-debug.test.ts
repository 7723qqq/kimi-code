import { describe, expect, it } from 'vitest';
import { renderBashDescription, withoutBackgroundDescription } from '../../src/tools/builtin/shell/bash';

describe('bash desc debug', () => {
  it('prints descriptions', () => {
    const full = renderBashDescription('bash');
    const noBg = withoutBackgroundDescription(full);
    console.log('FULL JSON:', JSON.stringify(full));
    console.log('NOBG JSON:', JSON.stringify(noBg));
    console.log('NOBG CONTAINS:', noBg.includes('Background execution is disabled for this agent.'));
    expect(true).toBe(true);
  });
});
