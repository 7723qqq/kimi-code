import { spawnSync } from 'node:child_process';
import os from 'node:os';

export const DEFAULT_TEST_CPU_LIMIT = 0;
const MANY_CORES = 8;

export function resolveTestCpuLimit(env = process.env) {
  if (env['KIMI_TEST_CPU_LIMIT'] === 'off') return 0;
  if (env['CI'] !== undefined && env['CI'] !== '') return 0;
  const raw = env['KIMI_TEST_CPU_LIMIT'];
  if (raw !== undefined) {
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_TEST_CPU_LIMIT;
  }
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  return cores > MANY_CORES ? DEFAULT_TEST_CPU_LIMIT : 0;
}

export function limitSelfToCpus(count, log = () => {}) {
  if (count < 1) return false;
  if (process.platform === 'win32') {
    const mask = (1n << BigInt(count)) - 1n;
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${process.pid}).ProcessorAffinity = ${mask}`,
      ],
      { stdio: 'ignore' },
    );
    if (result.status === 0) {
      log(`test cpu limit: ${count} cpu(s) (affinity 0x${mask.toString(16)})`);
      return true;
    }
    return false;
  }
  if (process.platform === 'linux') {
    const result = spawnSync('taskset', ['-pc', `0-${count - 1}`, String(process.pid)], {
      stdio: 'ignore',
    });
    if (result.status === 0) {
      log(`test cpu limit: ${count} cpu(s) (taskset 0-${count - 1})`);
      return true;
    }
    return false;
  }
  log(`test cpu limit: unsupported on ${process.platform}; running unrestricted`);
  return false;
}
