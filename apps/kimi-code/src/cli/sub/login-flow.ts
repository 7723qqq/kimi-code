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
import { createKimiHarnessV2 } from '@moonshot-ai/kimi-code-sdk';

import { createKimiCodeHostIdentity } from '#/cli/version';
import { t } from '#/i18n';
import { openUrl } from '#/utils/open-url';
import { persistedKimiOAuthRef, regionForBareLogin } from '#/utils/region';

/** Parse a `--region` CLI flag; exits with an actionable message on bad input. */
export function parseRegionFlag(value: string): KimiRegion {
  if (value !== 'mainland-cn' && value !== 'global') {
    process.stderr.write(`Invalid --region "${value}" (expected "mainland-cn" or "global").\n`);
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
        `Found existing Google Antigravity login (${antigravity.email ?? 'active user'}). Checking credentials...\n`,
      );
      // Import alone proves nothing: validate that the token is usable
      // (unexpired or refreshable) before committing to the sync path.
      const accessToken = await new GoogleOAuthManager()
        .getValidAccessToken()
        .catch(() => undefined);
      if (accessToken !== undefined && accessToken.length > 0) {
        process.stderr.write('Using the synced Google Antigravity credentials.\n');
        return runAntigravitySyncFlow();
      }
      process.stderr.write(
        'Stored Google credentials are expired or not refreshable. Falling back to browser login.\n',
      );
    }
    return runGoogleLoginFlow();
  }
  // No flag: a fresh install follows the resolved region (env/marker/
  // default); an existing login keeps its own environment (see
  // regionForBareLogin — the default slot re-pins mainland-cn, a scoped slot
  // keeps its configured hosts).
  const region = options.region ?? regionForBareLogin(persistedKimiOAuthRef());
  const identity = createKimiCodeHostIdentity();
  const harness = createKimiHarnessV2({
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
            `Opening browser for Kimi device login: ${url}`,
            `If the browser did not open, paste the URL above and enter code: ${data.userCode}`,
            data.expiresIn !== null && data.expiresIn !== undefined
              ? `Code expires in ${data.expiresIn}s.`
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

export async function runGoogleLoginFlow(): Promise<never> {
  const manager = new GoogleOAuthManager();
  const identity = createKimiCodeHostIdentity();
  const harness = createKimiHarnessV2({
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
            `Opening browser for Google Gemini authorization: ${data.authUrl}`,
            `If the browser did not open, paste the URL above into your browser.`,
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
    applyGoogleGeminiConfig(config as ManagedKimiConfigShape, {
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
      `Logged in to Google Gemini (${result.providerName}). Default model set to ${config.defaultModel}.\n`,
    );
    process.exit(0);
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write('Login cancelled.\n');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Google login failed: ${message}\n`);
    }
    process.exit(1);
  }
}

export async function runAntigravitySyncFlow(): Promise<never> {
  const manager = new GoogleOAuthManager();
  const identity = createKimiCodeHostIdentity();
  const harness = createKimiHarnessV2({
    identity,
    uiMode: 'cli',
  });

  const detection = GoogleOAuthManager.detectAntigravityCredentials();
  if (!detection.available) {
    process.stderr.write(
      'No Google Antigravity credentials found at ~/.gemini/oauth_creds.json.\n',
    );
    process.exit(1);
  }

  const token = await manager.importAntigravityCredentials();
  if (!token) {
    process.stderr.write('Failed to import Google credentials from ~/.gemini/oauth_creds.json.\n');
    process.exit(1);
  }

  const config = await harness.getConfig();
  applyGoogleGeminiConfig(config as ManagedKimiConfigShape, {
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
    `Synced Google Antigravity account (${detection.email ?? 'active user'}). Default model set to ${config.defaultModel}.\n`,
  );
  process.exit(0);
}
