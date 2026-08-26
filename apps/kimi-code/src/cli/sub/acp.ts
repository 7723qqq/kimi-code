import type { Command } from 'commander';

import { registerNativeAcpCommand } from './acp-native';

export function registerAcpCommand(parent: Command): void {
  registerNativeAcpCommand(parent);
}
