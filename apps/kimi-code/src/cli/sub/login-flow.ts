/**
 * Shared device-code login flow used by both `kimi login` (top-level
 * subcommand) and `kimi acp --login` (the first-class ACP terminal-auth
 * entry point). Exiting the process is part of the contract — callers
 * MUST treat the returned promise as `Promise<never>`.
 */

import {
  applyGoogleGeminiConfig,
  GOOGLE_GEMINI_DEFAULT_MODEL_ID,
  GoogleOAuthManager,
  OAuthAccessDeniedError,
  type DeviceAuthorization,
  type KimiRegion,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { createKimiCodeHostIdentity } from '#/cli/version';
import { t } from '#/i18n';
import { openUrl } from '#/utils/open-url';
import { persistedKimiOAuthRef, regionForBareLogin } from '#/utils/region';

/** Parse a `--region` CLI flag; exits with an actionable message on bad input. */
export function parseRegionFlag(value: string): KimiRegion {
  if (value !== 'mainland-cn' && value !== 'global') {
    process.stderr.write(t('tui.statusMessages.loginInvalidRegion', { value }) + '\n');
    process.exit(1);
  }
  return value;
}

export async function runLoginFlow(
  options: { region?: KimiRegion; provider?: string } = {},
): Promise<never> {
  if (options.provider === 'antigravity' || options.provider === 'google-antigravity') {
    return runAntigravitySyncFlow();
  }
  if (options.provider === 'google' || options.provider === 'gemini') {
    const antigravity = GoogleOAuthManager.detectAntigravityCredentials();
    if (antigravity.available) {
      process.stderr.write(
        t('tui.statusMessages.loginAntigravityFound', {
          email: antigravity.email ?? t('tui.statusMessages.loginActiveUser'),
        }) + '\n',
      );
      // Import alone proves nothing: validate that the token is usable
      // (unexpired or refreshable) before committing to the sync path.
      const accessToken = await new GoogleOAuthManager()
        .getValidAccessToken()
        .catch(() => undefined);
      if (accessToken !== undefined && accessToken.length > 0) {
        process.stderr.write(t('tui.statusMessages.loginAntigravityUsingSynced') + '\n');
        return runAntigravitySyncFlow();
      }
      process.stderr.write(t('tui.statusMessages.loginAntigravityExpired') + '\n');
    }
    return runGoogleLoginFlow();
  }
  // No flag: a fresh install follows the resolved region (env/marker/
  // default); an existing login keeps its own environment (see
  // regionForBareLogin — the default slot re-pins mainland-cn, a scoped slot
  // keeps its configured hosts).
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
      onDeviceCode: (data: DeviceAuthorization) => {
        const url = data.verificationUriComplete || data.verificationUri;
        // Print the manual fallback before attempting to open the user's
        // browser so headless/browser-opener failures never hide the URL
        // and code needed to complete login.
        process.stderr.write(
          [
            '',
            t('tui.statusMessages.loginOpeningBrowser', { url }),
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
        } catch {
          // Best effort only: the manual fallback has already been printed.
        }
      },
    });
    process.stderr.write(
      t('tui.statusMessages.loginSuccess', { provider: result.providerName }) + '\n',
    );
    process.exit(0);
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write(t('tui.statusMessages.loginCancelledMsg') + '\n');
    } else if (error instanceof OAuthAccessDeniedError) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(t('tui.statusMessages.loginCancelledWithErrorMsg', { message }) + '\n');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(t('tui.statusMessages.loginFailedMsg', { message }) + '\n');
    }
    process.exit(1);
  }
}

export async function runGoogleLoginFlow(): Promise<never> {
  const manager = new GoogleOAuthManager();
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
    const result = await manager.startLoginFlow({
      signal: controller.signal,
      onAuthUrl: (data) => {
        process.stderr.write(
          [
            '',
            t('tui.statusMessages.loginGoogleOpeningBrowser', { url: data.authUrl }),
            t('tui.statusMessages.loginGooglePasteUrl'),
            t('tui.statusMessages.loginWaiting'),
            '',
          ].join('\n'),
        );
        try {
          openUrl(data.authUrl);
        } catch {
          // Best effort
        }
      },
    });

    const config = await harness.getConfig();
    const applied = applyGoogleGeminiConfig(config as ManagedKimiConfigShape, {
      authType: 'oauth',
      selectedModel: GOOGLE_GEMINI_DEFAULT_MODEL_ID,
      thinking: true,
      effort: 'high',
    });

    await harness.setConfig({
      providers: config.providers,
      models: config.models,
      defaultModel: config.defaultModel,
      thinking: config.thinking,
    });

    process.stderr.write(
      t('tui.statusMessages.loginGoogleSuccess', {
        provider: result.providerName,
        model: applied.defaultModel,
      }) + '\n',
    );
    process.exit(0);
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write(t('tui.statusMessages.loginCancelledMsg') + '\n');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(t('tui.statusMessages.googleLoginFailedMsg', { message }) + '\n');
    }
    process.exit(1);
  }
}

export async function runAntigravitySyncFlow(): Promise<never> {
  const manager = new GoogleOAuthManager();
  const identity = createKimiCodeHostIdentity();
  const harness = createKimiHarness({
    identity,
    uiMode: 'cli',
  });

  const detection = GoogleOAuthManager.detectAntigravityCredentials();
  if (!detection.available) {
    process.stderr.write(t('tui.statusMessages.loginAntigravityNoCreds') + '\n');
    process.exit(1);
  }

  const token = await manager.importAntigravityCredentials();
  if (!token) {
    process.stderr.write(t('tui.statusMessages.loginAntigravityImportFailed') + '\n');
    process.exit(1);
  }

  const config = await harness.getConfig();
  const applied = applyGoogleGeminiConfig(config as ManagedKimiConfigShape, {
    authType: 'oauth',
    selectedModel: GOOGLE_GEMINI_DEFAULT_MODEL_ID,
    thinking: true,
    effort: 'high',
  });

  await harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    thinking: config.thinking,
  });

  process.stderr.write(
    t('tui.statusMessages.loginAntigravitySynced', {
      email: detection.email ?? t('tui.statusMessages.loginActiveUser'),
      model: applied.defaultModel,
    }) + '\n',
  );
  process.exit(0);
}
