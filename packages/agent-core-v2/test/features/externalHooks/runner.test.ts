import { describe, expect, it } from 'bun:test';

import { buildHookSpawnOptions, runHook } from '#/features/externalHooks/internal/runHook';
import { renderUserPromptHookResult } from '#/features/externalHooks/internal/userPrompt';
import { HostProcessService } from '#/os/backends/host/hostProcessService';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hostProcess = new HostProcessService();

const MAX_HOOK_OUTPUT_CHARS = 64 * 1024;
const TRUNCATED_MARKER = '\n[hook output truncated]';
const HOOK_BIN = process.execPath;
const quotedPath = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);

function nodeCommand(source: string): string {
  const file = join(tmpdir(), `kimi-hook-${randomUUID()}.mjs`);
  writeFileSync(file, source);
  return `${quotedPath(HOOK_BIN)} ${quotedPath(file)}`;
}

describe('runHook process runner', () => {
  it('returns allow when the hook exits 0 and captures stdout', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand(`process.stdout.write("ok" + String.fromCharCode(10));`),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.stdout?.trim()).toBe('ok');
  });

  it('parses stdout JSON message into a hook result message', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(JSON.stringify({ message: "hook says hi" }));'),
      {},
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.message).toBe('hook says hi');
    expect(result.structuredOutput).toBe(true);
  });

  it('marks structured stdout JSON without message as empty hook output', async () => {
    const emptyObject = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("{}");'),
      {},
      { timeout: 5 },
    );
    expect(emptyObject.action).toBe('allow');
    expect(emptyObject.message).toBeUndefined();
    expect(emptyObject.structuredOutput).toBe(true);

    const emptyHookSpecificOutput = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(JSON.stringify({ hookSpecificOutput: {} }));'),
      {},
      { timeout: 5 },
    );
    expect(emptyHookSpecificOutput.action).toBe('allow');
    expect(emptyHookSpecificOutput.message).toBeUndefined();
    expect(emptyHookSpecificOutput.structuredOutput).toBe(true);

    expect(renderUserPromptHookResult([emptyObject, emptyHookSpecificOutput])).toBeUndefined();

    const continueOnly = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(JSON.stringify({ continue: true }));'),
      {},
      { timeout: 5 },
    );
    expect(renderUserPromptHookResult([continueOnly])).toBeUndefined();

    const plainText = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("hook note");'),
      {},
      { timeout: 5 },
    );
    const secondNote = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("second note");'),
      {},
      { timeout: 5 },
    );
    const rendered = renderUserPromptHookResult([plainText, secondNote]);
    expect(rendered?.messages).toEqual(['hook note', 'second note']);
    expect(rendered?.parts).toEqual([
      {
        type: 'text',
        text: '<hook_result hook_event="UserPromptSubmit">\nhook note\n</hook_result>',
        meta: { contentType: 'text/xml', source: 'user prompt submit hook' },
      },
      {
        type: 'text',
        text: '<hook_result hook_event="UserPromptSubmit">\nsecond note\n</hook_result>',
        meta: { contentType: 'text/xml', source: 'user prompt submit hook' },
      },
    ]);
  });

  it('returns block when the hook exits 2 and captures stderr as the reason', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stderr.write("blocked\\n"); process.exit(2);'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.reason).toContain('blocked');
  });

  it('returns allow on non-zero, non-2 exit codes', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.exit(1);'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
  });

  it('returns allow with timedOut=true when the command exceeds the timeout', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('setTimeout(() => {}, 10000);'),
      { tool_name: 'Bash' },
      { timeout: 0.05 },
    );

    expect(result.action).toBe('allow');
    expect(result.timedOut).toBe(true);
  });

  it('parses stdout JSON permissionDecision=deny into a block result with the supplied reason', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand(
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "use rg" } }));',
      ),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.reason).toBe('use rg');
  });

  it('writes the input payload to the hook process stdin as JSON', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand([
        'let input = "";',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => {',
        '  const parsed = JSON.parse(input);',
        '  process.stdout.write(parsed.tool_name);',
        '});',
      ].join('\n')),
      { tool_name: 'Write' },
      { timeout: 5 },
    );

    expect(result.stdout?.trim()).toBe('Write');
  });
});

describe('runHook bounded output accumulation', () => {
  it('caps stdout at the limit, appends a truncation marker and flags the result', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("x".repeat(5 * 1024 * 1024));'),
      {},
      { timeout: 20 },
    );

    expect(result.action).toBe('allow');
    expect(result.stdout?.length).toBe(MAX_HOOK_OUTPUT_CHARS + TRUNCATED_MARKER.length);
    expect(result.stdout?.endsWith(TRUNCATED_MARKER)).toBe(true);
    expect(result.stdout?.startsWith('xxxx')).toBe(true);
    expect(result.outputTruncated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('caps stderr at the limit and flags the result', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stderr.write("e".repeat(5 * 1024 * 1024));'),
      {},
      { timeout: 20 },
    );

    expect(result.action).toBe('allow');
    expect(result.stderr?.length).toBe(MAX_HOOK_OUTPUT_CHARS + TRUNCATED_MARKER.length);
    expect(result.stderr?.endsWith(TRUNCATED_MARKER)).toBe(true);
    expect(result.outputTruncated).toBe(true);
  });

  it('flags truncation on the block path when the hook exits 2 after massive output', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stderr.write("e".repeat(5 * 1024 * 1024)); process.exit(2);'),
      {},
      { timeout: 20 },
    );

    expect(result.action).toBe('block');
    expect(result.stderr?.length).toBe(MAX_HOOK_OUTPUT_CHARS + TRUNCATED_MARKER.length);
    expect(result.outputTruncated).toBe(true);
  });

  it('reclaims the process on the timeout path even when output was truncated', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("x".repeat(5 * 1024 * 1024)); setTimeout(() => {}, 10000);'),
      {},
      { timeout: 0.5 },
    );

    expect(result.action).toBe('allow');
    expect(result.timedOut).toBe(true);
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout?.length).toBe(MAX_HOOK_OUTPUT_CHARS + TRUNCATED_MARKER.length);
  });

  it('leaves sub-limit output byte-for-byte intact and unmarked', async () => {
    const payload = 'y'.repeat(4096);
    const result = await runHook(
      hostProcess,
      nodeCommand(`process.stdout.write("y".repeat(4096));`),
      {},
      { timeout: 5 },
    );

    expect(result.stdout).toBe(payload);
    expect(result.stdout?.includes(TRUNCATED_MARKER)).toBe(false);
    expect(result.outputTruncated).toBeFalsy();
  });
});

describe('buildHookSpawnOptions (Windows console-window regression)', () => {
  it('sets windowsHide:true so hooks do not flash a console on Windows', () => {
    expect(buildHookSpawnOptions({}).windowsHide).toBe(true);
  });

  it('runs through the shell with stdio piped', () => {
    const options = buildHookSpawnOptions({});
    expect(options.shell).toBe(true);
    expect(options.stdio).toBe('pipe');
  });

  it('merges hook env onto process.env and forwards cwd', () => {
    const options = buildHookSpawnOptions({ cwd: '/repo', env: { FOO: 'bar' } });
    expect(options.cwd).toBe('/repo');
    expect(options.env).toMatchObject({ FOO: 'bar' });
  });
});
