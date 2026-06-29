/**
 * Vitest global setup for the agent-core-v2 examples.
 *
 * Picks a single `KIMI_CODE_HOME` for the whole run (one
 * `.vitest-results/kimi-code-{timestamp}/` directory) and publishes it through
 * the environment so every example file in the invocation writes into the same
 * directory. The previous value is restored in the teardown.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export default function setup(): () => void {
  const previous = process.env['KIMI_CODE_HOME'];
  const ts = new Date().toISOString().replaceAll(/[-:.Z]/g, '');
  const homeDir = join(import.meta.dirname, '..', '.vitest-results', `kimi-code-${ts}`);
  mkdirSync(homeDir, { recursive: true });
  process.env['KIMI_CODE_HOME'] = homeDir;

  return () => {
    if (previous === undefined) {
      delete process.env['KIMI_CODE_HOME'];
    } else {
      process.env['KIMI_CODE_HOME'] = previous;
    }
  };
}
