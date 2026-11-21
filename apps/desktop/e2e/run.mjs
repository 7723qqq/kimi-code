import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// oxlint-disable-next-line import/extensions -- Node runs this file with type stripping, which requires the explicit .ts specifier.
import { playwrightEnv } from './mode-env.ts';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const args = process.argv.slice(2).filter(arg => arg !== '--');
const headless = process.env.npm_lifecycle_event === 'e2e:headless';
const build = !args.includes('--no-build');
const playwrightArgs = args.filter(arg => arg !== '--no-build');

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, { cwd: desktopDir, stdio: 'inherit', shell: false, env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const hasXvfb = process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
const playwright = [require.resolve('@playwright/test/cli'), 'test', '-c', 'e2e', ...playwrightArgs];
if (build) run(process.execPath, ['run', 'build']);
const env = { ...playwrightEnv(headless, process.env), KIMI_DESKTOP_BUN_PATH: process.execPath };
if (hasXvfb && (headless || !process.env.DISPLAY)) run('xvfb-run', ['--auto-servernum', '--server-args=-screen 0 1920x1080x24', process.execPath, ...playwright], env);
else run(process.execPath, playwright, env);
