import * as vscode from 'vscode';

import type { ExtensionConfig } from '../../shared/types';

declare const __EXTENSION_VERSION__: string;
const EXTENSION_VERSION = __EXTENSION_VERSION__ !== undefined ? __EXTENSION_VERSION__ : '0.0.0';

/**
 * Deprecated backdoor: the legacy v1 engine was removed, so a truthy value no
 * longer changes engine selection. Kept for compatibility with old setups.
 */
export const LEGACY_ENGINE_ENV = 'KIMI_CODE_LEGACY_FLAG';

const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * Engine-selection decision for the whole extension. Kept for compatibility:
 * the legacy v1 engine was removed and `createKimiHarness` is the same factory
 * as `createKimiHarnessV2`, so neither the flag nor the setting changes the
 * engine. Both paths resolve to the v2 engine.
 */
export function resolveUseAgentCoreV1(
  settingValue: boolean,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (TRUTHY_ENV_VALUES.has((env[LEGACY_ENGINE_ENV] ?? '').trim().toLowerCase())) {
    return true;
  }
  return settingValue;
}

function getConfig() {
  return vscode.workspace.getConfiguration('kimi');
}

export const VSCodeSettings = {
  get yoloMode(): boolean {
    return getConfig().get<boolean>('yoloMode', false);
  },

  get autosave(): boolean {
    return getConfig().get<boolean>('autosave', true);
  },

  get enableNewConversationShortcut(): boolean {
    return getConfig().get<boolean>('enableNewConversationShortcut', false);
  },

  get useCtrlEnterToSend(): boolean {
    return getConfig().get<boolean>('useCtrlEnterToSend', false);
  },

  get showThinkingContent(): boolean {
    return getConfig().get<boolean>('showThinkingContent', true);
  },

  get showThinkingExpanded(): boolean {
    return getConfig().get<boolean>('showThinkingExpanded', false);
  },

  get editorContext(): 'never' | 'onConversationStart' | 'onFileChange' {
    return getConfig().get<'never' | 'onConversationStart' | 'onFileChange'>(
      'editorContext',
      'never',
    );
  },

  /** Read once at activation; a change needs a window reload to take effect. */
  get useAgentCoreV1(): boolean {
    return resolveUseAgentCoreV1(getConfig().get<boolean>('useAgentCoreV1', false), process.env);
  },

  getExtensionConfig(): ExtensionConfig {
    return {
      yoloMode: this.yoloMode,
      autosave: this.autosave,
      useCtrlEnterToSend: this.useCtrlEnterToSend,
      enableNewConversationShortcut: this.enableNewConversationShortcut,
      showThinkingContent: this.showThinkingContent,
      showThinkingExpanded: this.showThinkingExpanded,
      version: EXTENSION_VERSION,
    };
  },
};

export function onSettingsChange(callback: (changedKeys: string[]) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('kimi')) {
      return;
    }
    const keys = [
      'yoloMode',
      'autosave',
      'enableNewConversationShortcut',
      'useCtrlEnterToSend',
      'showThinkingContent',
      'showThinkingExpanded',
      'editorContext',
    ];
    const changedKeys = keys.filter((key) => e.affectsConfiguration(`kimi.${key}`));
    if (changedKeys.length > 0) {
      callback(changedKeys);
    }
  });
}
