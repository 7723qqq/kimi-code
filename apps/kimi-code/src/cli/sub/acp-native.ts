/**
 * Native `kimi acp` implementation.
 *
 * Starts the Agent Client Protocol (ACP) server backed directly by the
 * DI × Scope agent engine (`agent-core-v2`) over stdio, so ACP-compatible
 * clients can drive a kimi-code session on the default engine.
 *
 * Wire-up mirrors `kimi acp` for the parts that are host-independent:
 *  - `--login` pivots into the shared device-code login flow (the entry point
 *    ACP clients hit via the first-class `AuthMethodTerminal` path, re-invoking
 *    the agent binary with the advertised `args:['--login']`).
 *  - `KIMI_CODE_HOME` (if set) is forwarded into `authMethods[0].env` so the
 *    login subprocess writes its token under the same data root the server
 *    reads from, and `process.argv[1]` is advertised as the legacy
 *    `_meta['terminal-auth'].command` fallback.
 *
 * `@moonshot-ai/acp-server` (and its `agent-core-v2` engine) is loaded via a
 * lazy dynamic import so parsing the CLI does not initialize the ACP engine —
 * mirroring the `kimi server run` v2 routing in `#/cli/sub/server/run.ts`.
 */

import type { Command } from 'commander';

import { registerAcpCommand } from './acp';

export function registerNativeAcpCommand(parent: Command): void {
  registerAcpCommand(parent);
}

