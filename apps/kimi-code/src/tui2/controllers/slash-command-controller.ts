/**
 * TUI2 SlashCommandController — modular slash-command execution coordinator.
 *
 * Dispatches slash-command inputs to their concrete handlers through the
 * dispatch subsystem and manages busy-state restoration.
 *
 * Status: REAL (tui2). Modular slash command executor extracted from KimiTUI.
 */

import type { SlashCommandHost } from '../commands/dispatch';
import { dispatchInput } from '../commands/dispatch';
import type { SlashCommandIntent } from '../commands/resolve';
import { resolveSlashCommandInput } from '../commands/resolve';
import type { Tui2Store } from '../state';

export interface SlashCommandControllerOptions {
  readonly host: SlashCommandHost;
  readonly store: Tui2Store;
}

export class SlashCommandController {
  constructor(private readonly options: SlashCommandControllerOptions) {}

  resolve(input: string): SlashCommandIntent {
    const isStreaming = this.options.store.state.streamingPhase !== 'idle';
    const isCompacting = this.options.store.state.queuePane?.isCompacting ?? false;
    return resolveSlashCommandInput({
      input,
      skillCommandMap: this.options.host.skillCommandMap,
      pluginCommandMap: this.options.host.pluginCommandMap,
      isStreaming,
      isCompacting,
    });
  }

  dispatch(input: string): void {
    dispatchInput(this.options.host, input);
  }
}
