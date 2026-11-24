import type { ModelSwitchLocalizedString } from './modelSwitchConfirm';

export const EFFORT_SWITCH_CONFIG_NAME = 'effort_switch_confirm';

export interface EffortSwitchConfig {
  descriptions: {
    enable: boolean;
    items: Record<string, ModelSwitchLocalizedString>;
  };
}

function parseDescriptions(raw: unknown): EffortSwitchConfig['descriptions'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { enable: false, items: {} };
  }
  const record = raw as Record<string, unknown>;
  const items: Record<string, ModelSwitchLocalizedString> = {};
  const rawItems = record['items'];
  if (typeof rawItems === 'object' && rawItems !== null && !Array.isArray(rawItems)) {
    for (const [effort, value] of Object.entries(rawItems)) {
      if (typeof value !== 'object' || value === null) continue;
      const localized = value as Record<string, unknown>;
      if (localized['en'] !== undefined && typeof localized['en'] !== 'string') continue;
      if (localized['zh'] !== undefined && typeof localized['zh'] !== 'string') continue;
      items[effort] = {
        en: typeof localized['en'] === 'string' ? localized['en'] : undefined,
        zh: typeof localized['zh'] === 'string' ? localized['zh'] : undefined,
      };
    }
  }
  return { enable: record['enable'] === true, items };
}

export function parseEffortSwitchConfig(raw: unknown): EffortSwitchConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { descriptions: { enable: false, items: {} } };
  }
  return { descriptions: parseDescriptions((raw as Record<string, unknown>)['descriptions']) };
}

export function resolveEffortDescription(
  config: EffortSwitchConfig | undefined,
  effort: string,
  locale: 'en' | 'zh',
): string | undefined {
  if (config?.descriptions?.enable !== true) return undefined;
  const description = config.descriptions.items?.[effort];
  if (description === undefined) return undefined;
  return (locale === 'zh' ? description.zh : undefined) ?? description.en;
}
