/**
 * `kimi acp` sub-command routing.
 *
 * The command always runs on the agent-core-v2 engine: it delegates to
 * {@link registerNativeAcpCommand} (`./acp-native.ts`), which starts the
 * `@moonshot-ai/acp-server` ACP server over stdio. The legacy
 * `@moonshot-ai/acp-adapter` / SDK-harness implementation was removed with the
 * v1 engine.
 */

import type { Command } from 'commander';

import { registerNativeAcpCommand } from './acp-native';

export function registerAcpCommand(parent: Command): void {
  registerNativeAcpCommand(parent);
}
