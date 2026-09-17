/**
 * Native `kimi acp` registration.
 *
 * Delegates to `registerAcpCommand` in `./acp`; the ACP server itself is the
 * Rust `kimi-agent-cli --acp` process.
 */

import type { Command } from 'commander';

import { registerAcpCommand } from './acp';

export function registerNativeAcpCommand(parent: Command): void {
  registerAcpCommand(parent);
}

