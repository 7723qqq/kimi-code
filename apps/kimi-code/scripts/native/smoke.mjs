import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { fail } from './exec.mjs';
import { appRoot, nativeBinPath, nativeSmokeHome, targetTriple } from './paths.mjs';

const execFileAsync = promisify(execFile);
const target = targetTriple();
const executablePath = nativeBinPath(target);
const smokeHome = nativeSmokeHome();
const packageJson = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf-8'));
const expectedVersion = packageJson.version;

async function ensureExecutableExists() {
  try {
    await stat(executablePath);
  } catch {
    fail(`Native executable not found at ${executablePath}. Run build:native:bun first.`);
  }
}

async function runKimi(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, {
      cwd: appRoot,
      maxBuffer: 1024 * 1024 * 16,
      env: env === undefined ? undefined : { ...process.env, ...env },
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    fail(`Native smoke failed: ${executablePath} ${args.join(' ')}\n${detail}`);
  }
}

function assertIncludes(output, expected, command) {
  if (!output.includes(expected)) {
    fail(`Native smoke output for "${command}" did not include "${expected}".\n${output}`);
  }
}

await ensureExecutableExists();

const versionOutput = await runKimi(['--version']);
assertIncludes(versionOutput, expectedVersion, '--version');

const helpOutput = await runKimi(['--help']);
assertIncludes(helpOutput, 'Usage: kimi', '--help');

const exportHelpOutput = await runKimi(['export', '--help']);
assertIncludes(exportHelpOutput, 'Usage: kimi export', 'export --help');

const smokeCache = resolve(smokeHome, 'cache');
await rm(smokeHome, { recursive: true, force: true });
await mkdir(smokeCache, { recursive: true });
try {
  const nativeAssetOutput = await runKimi(['--version'], {
    KIMI_CODE_CACHE_DIR: smokeCache,
    KIMI_CODE_HOME: smokeHome,
    KIMI_CODE_NATIVE_ASSET_SMOKE: '1',
  });
  assertIncludes(nativeAssetOutput, `Native asset smoke passed: ${target}`, 'native asset smoke');
  assertIncludes(nativeAssetOutput, 'MiniDb worker build passed', 'MiniDb worker smoke');
  assertIncludes(nativeAssetOutput, 'search worker ready', 'search worker smoke');
} finally {
  await rm(smokeHome, { recursive: true, force: true });
}

// Plugin MCP servers declared with `command: "node"` are re-executed through
// this binary as `__plugin_run_node`, which loads the plugin script with a
// dynamic import(). Keep that path covered so bundler or SEA settings that
// break dynamic import() fail here instead of inside users' plugins.
const pluginRoot = resolve(smokeHome, 'plugin');
await rm(smokeHome, { recursive: true, force: true });
await mkdir(pluginRoot, { recursive: true });
try {
  const pluginEntry = resolve(pluginRoot, 'entry.mjs');
  await writeFile(
    pluginEntry,
    'await Promise.resolve();\nconsole.log(`plugin entry ran ${process.argv.slice(2).join(" ")}`);\n',
  );
  const pluginOutput = await runKimi(['__plugin_run_node', pluginEntry, 'alpha', 'beta'], {
    KIMI_CODE_HOME: smokeHome,
    KIMI_PLUGIN_ROOT: pluginRoot,
  });
  assertIncludes(pluginOutput, 'plugin entry ran alpha beta', 'plugin node entry');
} finally {
  await rm(smokeHome, { recursive: true, force: true });
}

// __run_code: the compiled binary hosts the code-runtime shim through this
// hidden subcommand. The runaway case runs under the same memory guard the
// executor attaches, so each matrix target exercises its real enforcement:
// Job Object commit cap on Windows, /proc watchdog on Linux, ps watchdog on
// macOS. The follow-up run proves the host process is unaffected.
const { createMemoryGuard, MEMORY_CAP_BYTES } = await import(
  '../../../../packages/agent-core-v2/src/features/codeRuntime/memoryGuard.ts'
);

function parseShimLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const message = JSON.parse(trimmed);
    return message && message.type === 'done' ? message : undefined;
  } catch {
    return undefined;
  }
}

async function runCodeShim(code, { withGuard }) {
  const child = Bun.spawn({
    cmd: [executablePath, '__run_code'],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, KIMI_CODE_HOME: smokeHome },
  });
  const guard = withGuard
    ? createMemoryGuard(child.pid, MEMORY_CAP_BYTES, () => child.kill())
    : undefined;
  const deadline = setTimeout(() => {
    child.kill();
  }, 45_000);
  const stderrPromise = new Response(child.stderr).text();
  try {
    child.stdin.write(JSON.stringify({ code, maxOutputChars: 100_000, timeoutMs: 60_000 }));
    await child.stdin.end();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done;
    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const parsed = parseShimLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (parsed !== undefined) done = parsed;
        index = buffer.indexOf('\n');
      }
      if (done !== undefined) break;
    }
    if (done === undefined) {
      done = parseShimLine(buffer);
    }
    if (done !== undefined) {
      child.kill();
      await child.exited;
      return { kind: done.error?.kind ?? 'ok', value: done.value, output: buffer };
    }
    await child.exited;
    const stderr = await stderrPromise;
    const output = `${buffer}\n${stderr}`;
    if (guard?.exceeded() === true) return { kind: 'memory-limit', output };
    const peak = guard?.peakBytes();
    if (peak !== undefined && peak >= MEMORY_CAP_BYTES * 0.9) {
      return { kind: 'memory-limit', output };
    }
    return { kind: 'worker-exit', output };
  } finally {
    clearTimeout(deadline);
    guard?.dispose();
    try {
      child.kill();
    } catch {}
  }
}

await rm(smokeHome, { recursive: true, force: true });
await mkdir(smokeHome, { recursive: true });
try {
  const normal = await runCodeShim('return 1 + 2;', { withGuard: false });
  if (normal.kind !== 'ok' || normal.value !== 3) {
    fail(`__run_code normal case failed: kind=${normal.kind} value=${String(normal.value)}\n${normal.output}`);
  }
  const runaway = await runCodeShim(
    'const a=[]; while(true) a.push(new Array(100000).fill(1));',
    { withGuard: true },
  );
  if (runaway.kind !== 'memory-limit') {
    fail(`__run_code runaway case: expected memory-limit, got ${runaway.kind}\n${runaway.output}`);
  }
  const after = await runCodeShim('return 6 * 7;', { withGuard: false });
  if (after.kind !== 'ok' || after.value !== 42) {
    fail(`__run_code host-survival case failed: kind=${after.kind} value=${String(after.value)}\n${after.output}`);
  }
} finally {
  await rm(smokeHome, { recursive: true, force: true });
}

console.log(`Native smoke passed: ${executablePath}`);
