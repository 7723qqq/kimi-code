import { log, type Logger } from '@moonshot-ai/kimi-code-sdk/logging';

export type UpdateLogger = Pick<Logger, 'info' | 'warn'>;

/**
 * `KIMI_CODE_NO_AUTO_UPDATE` (or the legacy `KIMI_CLI_NO_AUTO_UPDATE` alias)
 * fully disables automatic update behavior — no check, no background install,
 * no prompt, and no staged-swap at startup (see `native-swap.ts`). Migrated
 * from kimi-cli, where the variable gated all auto-update behavior. Accepts
 * the usual truthy values (`1`/`true`/`yes`/`on`).
 */
export function isAutoUpdateDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const truthy = (value?: string): boolean =>
    ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
  return truthy(env['KIMI_CODE_NO_AUTO_UPDATE']) || truthy(env['KIMI_CLI_NO_AUTO_UPDATE']);
}

/**
 * The persisted `[upgrade].auto_install` preference (defaults to true when
 * the config cannot be read). Gates the passive background install — and the
 * startup swap of automatically staged payloads (see `native-swap.ts`).
 *
 * The TUI config module pulls in the zod schema stack, so it is imported
 * lazily: this predicate runs on the startup path, which must stay free of
 * the schema stack until a staged update actually needs the preference.
 */
export async function shouldAutoInstallUpdates(logger: UpdateLogger = log): Promise<boolean> {
  try {
    const { loadTuiConfig } = await import('#/tui/config');
    const config = await loadTuiConfig();
    return config.upgrade.autoInstall;
  } catch (error) {
    // A config load failure must never block the update flow — fall back to
    // the safe default (auto-install on), but keep a diagnostic trace.
    try {
      logger.warn('failed to read auto-install preference', {
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (logError) {
      // Diagnostic logging must never affect update behavior.
      void logError;
    }
    return true;
  }
}
