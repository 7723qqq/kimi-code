/**
 * `kimi login` — drive the OAuth device-code flow non-interactively.
 * The `authMethods.terminal-auth.args=['login']` (legacy `_meta` path)
 * advertised by the ACP server points clients at this entry point. The
 * first-class ACP `args=['--login']` path enters the same flow via
 * `kimi acp --login`.
 */

import type { Command } from 'commander';

import { t } from '#/i18n';

import { parseRegionFlag, runLoginFlow } from './login-flow';

export function registerLoginCommand(parent: Command): void {
  parent
    .command('login')
    .description(t('cli.commandDescriptions.login'))
    .option(
      '--region <region>',
      'Login region: "mainland-cn" (kimi.com) or "global" (kimi.ai).',
    )
    .option(
      '--provider <provider>',
      'Login provider: "kimi" (default) or "google" / "gemini".',
    )
    .action(async (opts: { region?: string; provider?: string }) => {
      await runLoginFlow({
        region: opts.region === undefined ? undefined : parseRegionFlag(opts.region),
        provider: opts.provider,
      });
    });
}
