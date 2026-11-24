import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'bun',
  ['test', '--isolate', 'test/apiSurface.test.ts', '-t', 'publishes the reviewed'],
  {
    stdio: 'inherit',
    env: { ...process.env, TESTKIT_REFRESH: 'schema' },
  },
);

process.exit(result.status ?? 1);
