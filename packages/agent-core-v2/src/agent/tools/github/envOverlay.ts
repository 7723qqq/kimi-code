import type { ConfigEffectiveOverlay } from '#/app/config/config';
import { registerConfigOverlay } from '#/app/config/configOverlayContributions';
import { isPlainObject } from '#/app/config/configPure';

import { GITHUB_SECTION } from './configSection';

export const GITHUB_TOKEN_ENV_VARS = ['GITHUB_TOKEN', 'GH_TOKEN'] as const;
export const GITHUB_BASE_URL_ENV_VAR = 'GITHUB_API_URL';

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

function sectionOf(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? { ...value } : {};
}

function currentString(section: Record<string, unknown>, key: string): string | undefined {
  const value = section[key];
  return typeof value === 'string' ? trimmed(value) : undefined;
}

export const githubEnvOverlay: ConfigEffectiveOverlay = {
  apply(effective, getEnv) {
    const section = sectionOf(effective[GITHUB_SECTION]);
    let changed = false;

    if (currentString(section, 'token') === undefined) {
      for (const name of GITHUB_TOKEN_ENV_VARS) {
        const fromEnv = trimmed(getEnv(name));
        if (fromEnv !== undefined) {
          section['token'] = fromEnv;
          changed = true;
          break;
        }
      }
    }

    if (currentString(section, 'baseUrl') === undefined) {
      const fromEnv = trimmed(getEnv(GITHUB_BASE_URL_ENV_VAR));
      if (fromEnv !== undefined) {
        section['baseUrl'] = fromEnv;
        changed = true;
      }
    }

    if (!changed) return [];
    effective[GITHUB_SECTION] = section;
    return [GITHUB_SECTION];
  },

  strip(domain, value, rawSnake) {
    if (domain !== GITHUB_SECTION || !isPlainObject(value)) return value;
    const raw = sectionOf(rawSnake[GITHUB_SECTION]);
    const next: Record<string, unknown> = { ...value };
    if (!('token' in raw)) delete next['token'];
    if (!('base_url' in raw)) delete next['baseUrl'];
    return next;
  },
};

registerConfigOverlay(githubEnvOverlay);
