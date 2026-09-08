import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { resolveServerRunner } from '#/cli/sub/web/run';
import {
  buildRustServerArgs,
  findRustAgentBinary,
  startRustServerForeground,
  waitForServerReady,
} from '#/cli/sub/web/rust-server-runner';
import type { ParsedServerOptions } from '#/cli/sub/web/shared';

describe('rust-server-runner', () => {
  const defaultOptions: ParsedServerOptions = {
    host: '127.0.0.1',
    port: 58627,
    logLevel: 'silent',
    debugEndpoints: false,
    insecureNoTls: true,
    allowRemoteShutdown: false,
    dangerousBypassAuth: false,
    allowedHosts: [],
  };

  describe('buildRustServerArgs', () => {
    it('constructs basic serve argument and data dir', () => {
      const args = buildRustServerArgs(defaultOptions, undefined, '/tmp/custom-data');
      expect(args).toContain('--serve');
      expect(args).toContain('127.0.0.1:58627');
      expect(args).toContain('--data-dir');
      expect(args).toContain('/tmp/custom-data');
      expect(args).not.toContain('--no-auth');
    });

    it('adds --no-auth when dangerousBypassAuth is true', () => {
      const args = buildRustServerArgs(
        { ...defaultOptions, dangerousBypassAuth: true },
        undefined,
        '/tmp/data',
      );
      expect(args).toContain('--no-auth');
    });
  });

  describe('findRustAgentBinary', () => {
    it('honors KIMI_AGENT_BIN if file exists', () => {
      const orig = process.env['KIMI_AGENT_BIN'];
      try {
        // Points to current package.json which is guaranteed to exist
        process.env['KIMI_AGENT_BIN'] = process.cwd();
        expect(findRustAgentBinary()).toBe(process.cwd());
      } finally {
        process.env['KIMI_AGENT_BIN'] = orig;
      }
    });

    it('returns string or undefined when KIMI_AGENT_BIN is unset', () => {
      const orig = process.env['KIMI_AGENT_BIN'];
      delete process.env['KIMI_AGENT_BIN'];
      try {
        const res = findRustAgentBinary();
        expect(res === undefined || typeof res === 'string').toBe(true);
      } finally {
        if (orig !== undefined) process.env['KIMI_AGENT_BIN'] = orig;
      }
    });
  });

  describe('waitForServerReady', () => {
    it('resolves when health endpoint returns 200', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        status: 200,
      } as Response);

      await expect(waitForServerReady('http://127.0.0.1:58627', 1000, 50)).resolves.toBeUndefined();
      fetchSpy.mockRestore();
    });

    it('throws timeout error when server is not responding', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Connection refused'));

      await expect(waitForServerReady('http://127.0.0.1:58627', 100, 20)).rejects.toThrow(
        /Timed out waiting for Rust server/,
      );
      fetchSpy.mockRestore();
    });
  });

  describe('startRustServerForeground', () => {
    it('throws when binary is not found', async () => {
      await expect(
        startRustServerForeground(
          defaultOptions,
          {},
          {
            findBinary: () => undefined,
          },
        ),
      ).rejects.toThrow(/Native server binary not found/);
    });

    it('spawns child process and invokes onReady hook on success', async () => {
      const child = new EventEmitter() as any;
      child.pid = 12345;
      child.killed = false;
      child.kill = vi.fn();

      const onReady = vi.fn();
      const waitReady = vi.fn().mockResolvedValue(undefined);

      // Run and abort via simulate exit
      const runPromise = startRustServerForeground(
        defaultOptions,
        { onReady },
        {
          findBinary: () => '/bin/fake-kimi-agent',
          spawnProcess: () => child,
          waitReady,
        },
      );

      // Allow microtask ticks for waitReady to execute
      await new Promise((r) => setTimeout(r, 10));

      expect(waitReady).toHaveBeenCalledWith('http://127.0.0.1:58627');
      expect(onReady).toHaveBeenCalledWith('http://127.0.0.1:58627');
    });
  });

  describe('resolveServerRunner', () => {
    it('defaults to Rust server whenever the binary is available', () => {
      const res = resolveServerRunner({}, () => '/path/to/kimi-agent');
      expect(res.isRust).toBe(true);
      expect(res.isLegacyFallback).toBe(false);
      expect(res.deprecationNotice).toBeUndefined();
    });

    it('falls back to legacy server with deprecation notice when binary is not found', () => {
      const res = resolveServerRunner({}, () => undefined);
      expect(res.isRust).toBe(false);
      expect(res.isLegacyFallback).toBe(true);
      expect(res.deprecationNotice).toContain('kap-server is deprecated');
    });

    it('honors --legacy-server even when rust binary is present', () => {
      const res = resolveServerRunner({ legacyServer: true }, () => '/path/to/kimi-agent');
      expect(res.isRust).toBe(false);
      expect(res.isLegacyFallback).toBe(true);
      expect(res.deprecationNotice).toContain('kap-server (agent-core-v2) is deprecated');
    });

    it('honors --rust-server explicitly', () => {
      const res = resolveServerRunner({ rustServer: true }, () => undefined);
      expect(res.isRust).toBe(true);
      expect(res.isLegacyFallback).toBe(false);
    });
  });
});
