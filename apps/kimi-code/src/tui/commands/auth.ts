import {
  applyGoogleGeminiConfig,
  applyOpenPlatformConfig,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  GoogleOAuthManager,
  OpenPlatformApiError,
  type KimiRegion,
  type ManagedKimiCodeModelInfo,
  type ManagedKimiConfigShape,
  type OpenPlatformDefinition,
} from '@moonshot-ai/kimi-code-oauth';
import { log } from '@moonshot-ai/kimi-code-sdk';

const GOOGLE_GEMINI_PROVIDER_ID = 'google-gemini';
const GOOGLE_GEMINI_DEFAULT_MODEL_ID = 'gemini-3.7-flash';

import { t } from '#/i18n';
import type { ChoiceOption } from '../components/dialogs/choice-picker';
import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import {
  KIMI_CODE_GLOBAL_PLATFORM_VALUE,
  refreshKimiRegion,
} from '#/utils/region';
import type { LoginProgressSpinnerHandle } from '../types';
import {
  promptApiKey,
  promptLogoutProviderSelection,
  promptModelSelectionForOpenPlatform,
  promptPlatformSelection,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Auth: login / logout
// ---------------------------------------------------------------------------

export async function handleLoginCommand(host: SlashCommandHost): Promise<void> {
  const platformId = await promptPlatformSelection(host);
  if (platformId === undefined) return;

  if (platformId === 'kimi-code' || platformId === KIMI_CODE_GLOBAL_PLATFORM_VALUE) {
    const region: KimiRegion = platformId === KIMI_CODE_GLOBAL_PLATFORM_VALUE ? 'global' : 'mainland-cn';
    await handleKimiCodeOAuthLogin(host, region);
    return;
  }

  if (platformId === 'google-antigravity-sync') {
    await handleGoogleAntigravitySync(host);
    return;
  }

  if (platformId === 'google-oauth') {
    await handleGoogleOAuthLogin(host);
    return;
  }

  const platform = getOpenPlatformById(platformId);
  if (platform === undefined) return;
  await handleOpenPlatformLogin(host, platform);
}

async function handleKimiCodeOAuthLogin(
  host: SlashCommandHost,
  region: KimiRegion,
): Promise<void> {
  const status = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const alreadyLoggedIn = status.providers.some(
    (provider) => provider.providerName === DEFAULT_OAUTH_PROVIDER_NAME && provider.hasToken,
  );

  let spinner: LoginProgressSpinnerHandle | undefined;
  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;
  try {
    // The facade maps region → profile hosts (env overrides keep priority);
    // 'mainland-cn' is passed explicitly too so switching back overrides a
    // persisted global login.
    await host.harness.auth.login(DEFAULT_OAUTH_PROVIDER_NAME, {
      signal: controller.signal,
      region,
      onDeviceCode: (data) => {
        spinner = host.showLoginAuthorizationPrompt(data);
      },
    });
    refreshKimiRegion();
    spinner?.stop({ ok: true, label: t('tui.statusMessages.loggedIn') });
    spinner = undefined;
    try {
      await host.authFlow.refreshConfigAfterLogin();
    } catch (refreshError) {
      const message = formatErrorMessage(refreshError);
      host.showError(`Authentication successful, but failed to refresh config: ${message}`);
      return;
    }
    host.track('login', {
      provider: DEFAULT_OAUTH_PROVIDER_NAME,
      method: 'oauth',
      already_logged_in: alreadyLoggedIn,
    });
    if (alreadyLoggedIn) {
      host.showStatus(t('tui.statusMessages.alreadyLoggedInRefreshed'), 'success');
    }
  } catch (error) {
    const cancelled = controller.signal.aborted;
    spinner?.stop({
      ok: false,
      label: cancelled
        ? t('tui.statusMessages.loginCancelled')
        : t('tui.statusMessages.loginFailed'),
    });
    spinner = undefined;
    if (cancelled) return;
    log.warn('login failed', {
      providerName: DEFAULT_OAUTH_PROVIDER_NAME,
      alreadyLoggedIn,
      sessionId: host.session?.id,
      error,
    });
    const message = formatErrorMessage(error);
    host.showError(`Login failed: ${message}`);
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }
}

async function handleGoogleAntigravitySync(host: SlashCommandHost): Promise<void> {
  const manager = new GoogleOAuthManager();
  const token = await manager.importAntigravityCredentials();
  if (!token) {
    host.showError('Failed to import Google credentials from ~/.gemini/oauth_creds.json');
    return;
  }

  const config = await host.harness.getConfig();
  applyGoogleGeminiConfig(config as ManagedKimiConfigShape, {
    authType: 'oauth',
    selectedModel: GOOGLE_GEMINI_DEFAULT_MODEL_ID,
    thinking: true,
    effort: 'high',
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    thinking: config.thinking,
  });

  try {
    await host.authFlow.refreshConfigAfterLogin();
  } catch (refreshError) {
    const message = formatErrorMessage(refreshError);
    host.showError(`Authentication synced, but failed to refresh config: ${message}`);
    return;
  }

  const detection = GoogleOAuthManager.detectAntigravityCredentials();
  host.track('login', {
    provider: GOOGLE_GEMINI_PROVIDER_ID,
    method: 'antigravity_sync',
  });
  host.showStatus(
    `Google Antigravity synced (${detection.email ?? 'active account'}) · default model: ${config.defaultModel}`,
    'success',
  );
}

async function handleGoogleOAuthLogin(host: SlashCommandHost): Promise<void> {
  const detection = GoogleOAuthManager.detectAntigravityCredentials();
  if (detection.available) {
    return handleGoogleAntigravitySync(host);
  }

  const manager = new GoogleOAuthManager();
  const alreadyLoggedIn = await manager.hasToken();

  let spinner: LoginProgressSpinnerHandle | undefined;
  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;
  try {
    await manager.startLoginFlow({
      signal: controller.signal,
      onAuthUrl: (data) => {
        // showLoginAuthorizationPrompt opens the browser itself (once) and
        // renders the URL box; Google's browser flow has no user code.
        spinner = host.showLoginAuthorizationPrompt({
          verificationUriComplete: data.authUrl,
          title: t('tui.chrome.deviceCodeBox.googleTitle'),
        });
      },
    });

    spinner?.stop({ ok: true, label: 'Google login successful.' });
    spinner = undefined;

    const config = await host.harness.getConfig();
    applyGoogleGeminiConfig(config as ManagedKimiConfigShape, {
      authType: 'oauth',
      selectedModel: GOOGLE_GEMINI_DEFAULT_MODEL_ID,
      thinking: true,
      effort: 'high',
    });

    await host.harness.setConfig({
      providers: config.providers,
      models: config.models,
      defaultModel: config.defaultModel,
      thinking: config.thinking,
    });

    try {
      await host.authFlow.refreshConfigAfterLogin();
    } catch (refreshError) {
      const message = formatErrorMessage(refreshError);
      host.showError(`Authentication successful, but failed to refresh config: ${message}`);
      return;
    }

    host.track('login', {
      provider: GOOGLE_GEMINI_PROVIDER_ID,
      method: 'oauth',
      already_logged_in: alreadyLoggedIn,
    });
    host.showStatus(`Google login complete · default model: ${config.defaultModel}`, 'success');
  } catch (error) {
    const cancelled = controller.signal.aborted;
    spinner?.stop({
      ok: false,
      label: cancelled
        ? t('tui.statusMessages.loginCancelled')
        : t('tui.statusMessages.googleLoginFailed'),
    });
    spinner = undefined;
    if (cancelled) return;
    log.warn('google login failed', {
      providerName: GOOGLE_GEMINI_PROVIDER_ID,
      alreadyLoggedIn,
      sessionId: host.session?.id,
      error,
    });
    const message = formatErrorMessage(error);
    host.showError(`Google login failed: ${message}`);
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }
}

async function handleOpenPlatformLogin(
  host: SlashCommandHost,
  platform: OpenPlatformDefinition,
): Promise<void> {
  const consoleHost = platform.consoleUrl?.replace(/^https?:\/\//, '') ?? '';
  const platformName =
    consoleHost.length > 0
      ? `Kimi Platform (${consoleHost})`
      : t('tui.statusMessages.kimiPlatformDisplay');
  const subtitleLines = [
    `${'base_url'.padEnd(12)}${platform.baseUrl}`,
    `${t('tui.statusMessages.savedToLabel').padEnd(12)}~/.kimi-code/config.toml`,
  ];
  const apiKey = await promptApiKey(host, platformName, subtitleLines);
  if (apiKey === undefined) return;

  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;

  let models: ManagedKimiCodeModelInfo[];
  try {
    models = await fetchOpenPlatformModels(platform, apiKey, fetch, controller.signal);
    models = filterModelsByPrefix(models, platform);
  } catch (error) {
    if (controller.signal.aborted) return;
    const msg = formatErrorMessage(error);
    host.showError(`Failed to verify API key: ${msg}`);
    if (
      error instanceof OpenPlatformApiError &&
      error.status === 401
    ) {
      host.showStatus(t('tui.statusMessages.hintUseKimiCodeInstead'));
    }
    return;
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }

  if (models.length === 0) {
    host.showError(t('tui.statusMessages.noModelsForPlatform'));
    return;
  }

  const selection = await promptModelSelectionForOpenPlatform(host, models, platform);
  if (selection === undefined) return;

  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[platform.id] !== undefined) {
    await host.harness.removeProvider(platform.id);
  }

  const config = await host.harness.getConfig();
  applyOpenPlatformConfig(config as ManagedKimiConfigShape, {
    platform,
    models,
    selectedModel: selection.model,
    thinking: selection.thinking !== 'off',
    effort:
      selection.thinking !== 'off' && selection.thinking !== 'on'
        ? selection.thinking
        : undefined,
    apiKey,
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    thinking: config.thinking,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track('login', { provider: platform.id, method: 'api_key' });
  host.showStatus(`Setup complete: ${platform.name} · ${selection.model.id}`);
}

export async function handleLogoutCommand(host: SlashCommandHost): Promise<void> {
  const oauthStatus = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const hasOAuthToken = oauthStatus.providers.some(
    (p) => p.providerName === DEFAULT_OAUTH_PROVIDER_NAME && p.hasToken,
  );
  const config = await host.harness.getConfig();
  const hasManagedRemnant =
    hasOAuthToken || config.providers[DEFAULT_OAUTH_PROVIDER_NAME] !== undefined;
  const apiKeyProviderIds = Object.keys(config.providers ?? {})
    .filter((id) => id !== DEFAULT_OAUTH_PROVIDER_NAME)
    .toSorted();

  const options: ChoiceOption[] = [];
  if (hasManagedRemnant) {
    options.push({
      value: DEFAULT_OAUTH_PROVIDER_NAME,
      label: PRODUCT_NAME,
      description: t('tui.statusMessages.oauthLoginDescription'),
    });
  }
  for (const id of apiKeyProviderIds) {
    const baseUrl = config.providers[id]?.baseUrl;
    options.push({
      value: id,
      label: id,
      description: typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : undefined,
    });
  }

  if (options.length === 0) {
    host.showStatus(t('tui.statusMessages.nothingToLogout'));
    return;
  }

  const currentModel = host.state.appState.model.trim();
  const currentProvider = host.state.appState.availableModels[currentModel]?.provider;

  const target = await promptLogoutProviderSelection(host, options, currentProvider);
  if (target === undefined) return;

  if (target === DEFAULT_OAUTH_PROVIDER_NAME) {
    await host.harness.auth.logout(DEFAULT_OAUTH_PROVIDER_NAME);
  } else if (target === GOOGLE_GEMINI_PROVIDER_ID) {
    await new GoogleOAuthManager().logout();
    await host.harness.removeProvider(target);
  } else {
    await host.harness.removeProvider(target);
  }

  if (target === currentProvider) {
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
  } else {
    const updated = await host.harness.getConfig({ reload: true });
    host.setAppState({
      availableModels: updated.models ?? {},
      availableProviders: updated.providers ?? {},
    });
  }
  refreshKimiRegion();

  host.track('logout', { provider: target });
  const label = target === DEFAULT_OAUTH_PROVIDER_NAME ? PRODUCT_NAME : target;
  host.showStatus(`Logged out from ${label}.`);
}
