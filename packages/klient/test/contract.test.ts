/**
 * Scenario: runtime validation at Klient wire-contract boundaries.
 *
 * Exercises the session-creation and plugin-manifest schemas directly with no
 * external collaborators. Run with `cd packages/klient && bun test
 * test/contract.test.ts`.
 */

import { describe, expect, it } from 'bun:test';

import { promptPayloadSchema } from '../src/contract/agent/schemas.js';
import { mcpServerAuthFlowHandleSchema } from '../src/contract/global/mcpManagement.js';
import { pluginManifestSchema, pluginUpdateStatusSchema } from '../src/contract/global/plugins.js';
import { createSessionOptionsSchema } from '../src/contract/session/lifecycle.js';

type McpTimeoutField = 'startupTimeoutMs' | 'toolTimeoutMs';

const timeoutCases = [
  {
    surface: 'plugin manifests',
    parse: (field: McpTimeoutField, value: number) =>
      pluginManifestSchema.safeParse({
        name: 'example',
        mcpServers: {
          example: { transport: 'stdio', command: 'node', [field]: value },
        },
      }),
  },
].flatMap(({ surface, parse }) => [
  { surface, field: 'startupTimeoutMs' as const, parse },
  { surface, field: 'toolTimeoutMs' as const, parse },
]);

describe('MCP timeout contract validation', () => {
  it.each(timeoutCases)('accepts the maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_647).success).toBe(true);
  });

  it.each(timeoutCases)('rejects an above-maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_648).success).toBe(false);
  });

  it('session creation options accept ephemeral mcpServers', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        stdioExample: { transport: 'stdio', command: 'node', args: ['server.mjs'] },
        httpExample: { transport: 'http', url: 'https://example.com/mcp', headers: { a: 'b' } },
        sseExample: { transport: 'sse', url: 'https://example.com/sse' },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.mcpServers?.['stdioExample']).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
    });
  });

  it('session creation options preserve the per-server deferred field', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        stdioExample: { transport: 'stdio', command: 'node', deferred: false },
        httpExample: { transport: 'http', url: 'https://example.com/mcp', deferred: true },
        sseExample: { transport: 'sse', url: 'https://example.com/sse' },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.mcpServers?.['stdioExample']).toEqual({
      transport: 'stdio',
      command: 'node',
      deferred: false,
    });
    expect(parsed.data?.mcpServers?.['httpExample']).toEqual({
      transport: 'http',
      url: 'https://example.com/mcp',
      deferred: true,
    });
    expect(parsed.data?.mcpServers?.['sseExample']).toEqual({
      transport: 'sse',
      url: 'https://example.com/sse',
    });
  });

  it('session creation options reject malformed mcpServers entries', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        example: { transport: 'http', url: 'not-a-url' },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('completeAuth timeoutMs accepts the setTimeout maximum and rejects above it', () => {
    expect(
      mcpServerAuthFlowHandleSchema.safeParse({ flowId: 'flow-1', timeoutMs: 2_147_483_647 })
        .success,
    ).toBe(true);
    expect(
      mcpServerAuthFlowHandleSchema.safeParse({ flowId: 'flow-1', timeoutMs: 2_147_483_648 })
        .success,
    ).toBe(false);
  });

  it('plugin update status keeps the failure channel on the wire', () => {
    const parsed = pluginUpdateStatusSchema.safeParse({
      id: 'offline',
      source: 'github',
      current: { kind: 'tag', value: 'v1' },
      latest: { kind: 'tag', value: 'v1' },
      displayVersion: 'v1',
      updateAvailable: false,
      checkFailed: true,
      errorMessage: 'network offline',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      id: 'offline',
      source: 'github',
      current: { kind: 'tag', value: 'v1' },
      latest: { kind: 'tag', value: 'v1' },
      displayVersion: 'v1',
      updateAvailable: false,
      checkFailed: true,
      errorMessage: 'network offline',
    });
  });

  it('plugin update status leaves the failure channel unset on success', () => {
    const parsed = pluginUpdateStatusSchema.safeParse({
      id: 'good',
      source: 'github',
      latest: { kind: 'tag', value: 'v2' },
      displayVersion: 'v2',
      updateAvailable: true,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.checkFailed).toBeUndefined();
  });
});

describe('prompt contract validation', () => {
  it('rejects an empty caller-chosen promptId', () => {
    expect(promptPayloadSchema.safeParse({ input: [], promptId: '' }).success).toBe(false);
  });

  it('accepts a non-empty caller-chosen promptId', () => {
    expect(promptPayloadSchema.safeParse({ input: [], promptId: 'submission-1' }).success).toBe(
      true,
    );
  });
});
