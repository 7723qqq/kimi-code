import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { OAuthAccessDeniedError, type KimiRegion } from '@moonshot-ai/kimi-code-oauth';

import { createKimiCodeHostIdentity } from '#/cli/host-identity';
import { openUrl } from '#/utils/open-url';
import { persistedKimiOAuthRef, regionForBareLogin } from '#/utils/region';
import { t } from '#/i18n';

export function parseRegionFlag(value: string): KimiRegion {
  if (value !== 'mainland-cn' && value !== 'global') {
    process.stderr.write(`Invalid --region "${value}" (expected "mainland-cn" or "global").\n`);
    process.exit(1);
  }
  return value;
}

export async function runLoginFlow(options: { region?: KimiRegion } = {}): Promise<never> {
  const region = options.region ?? regionForBareLogin(persistedKimiOAuthRef());
  const identity = createKimiCodeHostIdentity();
  const harness = createKimiHarness({
    identity,
    uiMode: 'cli',
  });
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });
  try {
    const result = await harness.auth.login(undefined, {
      signal: controller.signal,
      region,
      onDeviceCode: (data) => {
        const url = data.verificationUriComplete || data.verificationUri;
        process.stderr.write(
          [
            '',
            t('tui.statusMessages.loginOpeningBrowser', { url: url }),
            t('tui.statusMessages.loginPasteUrl', { code: data.userCode }),
            data.expiresIn !== null && data.expiresIn !== undefined
              ? t('tui.statusMessages.loginCodeExpires', { seconds: data.expiresIn })
              : undefined,
            t('tui.statusMessages.loginWaiting'),
            '',
          ]
            .filter((line): line is string => line !== undefined)
            .join('\n'),
        );
        try {
          openUrl(url);
        } catch {}
      },
    });
    process.stderr.write(`Logged in to ${result.providerName}.\n`);
    process.exit(0);
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write('Login cancelled.\n');
    } else if (error instanceof OAuthAccessDeniedError) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Login cancelled: ${message}\n`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Login failed: ${message}\n`);
    }
    process.exit(1);
  }
}
