import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTestHome, until, writeKimiConfig, type TestHome } from '@moonshot-ai/testkit/fixtures';
import { fakeModelConfig, held, say, startFakeModel, type FakeModel } from '@moonshot-ai/testkit/model';

const SERVER = fileURLToPath(new URL('../../../../packages/agent-core-v2/test/mcpCore/fixtures/cwd-stdio-server.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
const LOADER = fileURLToPath(new URL('../../../../build/register-raw-text-loader.mjs', import.meta.url));
const ROOT_TSCONFIG = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url));

const homes: TestHome[] = [];
const models: FakeModel[] = [];

afterEach(async () => {
  for (const model of models.splice(0)) await model.close();
  for (const home of homes.splice(0)) await home.remove();
});

async function writeServer(file: string, name: string, startLog: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    mcpServers: {
      [name]: {
        command: process.execPath,
        args: [SERVER, name],
        env: { KIMI_TEST_MCP_START_LOG: startLog },
      },
    },
  }));
}

async function runPrint(args: readonly string[], session: string): Promise<void> {
  const home = await createTestHome('kimi-print-mcp');
  homes.push(home);
  const model = await startFakeModel();
  models.push(model);
  model.script(held('answer', say('done')));
  await writeKimiConfig(home.dataDir, fakeModelConfig(model));

  const root = await realpath(home.workspace);
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ extends: ROOT_TSCONFIG }));
  const startLog = join(home.root, 'mcp-starts.log');
  await writeFile(startLog, '');
  await writeServer(join(home.dataDir, 'mcp.json'), 'user', startLog);
  await writeServer(join(root, '.kimi-code', 'mcp.json'), 'project', startLog);
  await writeServer(join(root, 'src', '.kimi-code', 'mcp.json'), 'nested', startLog);

  const started = async (): Promise<string[]> => {
    const text = await readFile(startLog, 'utf8');
    return text.split('\n').filter(Boolean).toSorted();
  };

  const proc = Bun.spawn({
    cmd: [process.execPath, '--import', LOADER, CLI, ...args, '-p', 'hello'],
    cwd: root,
    env: {
      ...process.env,
      KIMI_CODE_HOME: home.dataDir,
      HOME: home.home,
      USERPROFILE: home.home,
      KIMI_CODE_WATCH: 'false',
      KIMI_CODE_TRUST_WORKSPACE: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0',
      KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0',
      KIMI_TEST_MCP_START_LOG: startLog,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();

  await model.hold('answer').reached({ timeoutMs: 60_000 });
  await until(
    `both MCP servers of the ${session} started`,
    async () => new Set(await started()).size === 2,
    { timeoutMs: 60_000 },
  );
  model.hold('answer').release();
  const exitCode = await proc.exited;
  const [out, err] = await Promise.all([stdout, stderr]);

  expect(exitCode, `stdout:\n${out}\nstderr:\n${err}`).toBe(0);
  const log = await readFile(join(home.dataDir, 'logs', 'kimi-code.log'), 'utf8').catch(() => '');
  expect(await started(), log).toEqual([`project ${root}`, `user ${root}`]);
}

describe('kimi -p MCP startup', () => {
  it('starts each MCP server of the project once, in the project directory, for a session that follows it', async () => {
    await runPrint([], 'main session');
  }, 120_000);

  it('starts each MCP server of the project once, in the project directory, for a session pinned to a subdirectory', async () => {
    await runPrint(['--environment', 'local', '--environment-cwd', 'src'], 'subdirectory session');
  }, 120_000);
});
