import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
import {
  type ConfigStripEnv,
  type EnvBindings,
  envBindings,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const SKILLS_SECTION = 'skills';
export const SkillsConfigSchema = z
  .object({
    hiddenFromModel: z.array(z.string()).optional(),
  })
  .optional();
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

registerConfigSection(SKILLS_SECTION, SkillsConfigSchema, { defaultValue: {} });

export function hiddenFromModelPatterns(config: IConfigService): readonly string[] {
  return config.get<SkillsConfig>(SKILLS_SECTION)?.hiddenFromModel ?? [];
}

export function isHiddenFromModel(name: string, patterns: readonly string[]): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) return false;
  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase();
    if (pattern.length === 0) continue;
    if (pattern.endsWith('*')) {
      if (normalized.startsWith(pattern.slice(0, -1))) return true;
      continue;
    }
    if (normalized === pattern) return true;
  }
  return false;
}

export const EXTRA_SKILL_DIRS_SECTION = 'extraSkillDirs';
export const ExtraSkillDirsConfigSchema = z.array(z.string()).optional();
export type ExtraSkillDirsConfig = z.infer<typeof ExtraSkillDirsConfigSchema>;

registerConfigSection(EXTRA_SKILL_DIRS_SECTION, ExtraSkillDirsConfigSchema, {
  defaultValue: [],
});

export const MERGE_ALL_AVAILABLE_SKILLS_SECTION = 'mergeAllAvailableSkills';
export const MergeAllAvailableSkillsConfigSchema = z.boolean().optional();
export type MergeAllAvailableSkillsConfig = z.infer<typeof MergeAllAvailableSkillsConfigSchema>;

registerConfigSection(MERGE_ALL_AVAILABLE_SKILLS_SECTION, MergeAllAvailableSkillsConfigSchema, {
  defaultValue: true,
});

export const BUILTIN_PRODUCT_SKILLS_SECTION = 'builtinProductSkills';
export const BuiltinProductSkillsConfigSchema = z.boolean().optional();
export type BuiltinProductSkillsConfig = z.infer<typeof BuiltinProductSkillsConfigSchema>;

export const BUILTIN_PRODUCT_SKILLS_ENV = 'KIMI_CODE_BUILTIN_PRODUCT_SKILLS';

export const builtinProductSkillsEnvBindings: EnvBindings<BuiltinProductSkillsConfig> = envBindings(
  BuiltinProductSkillsConfigSchema,
  {
    env: BUILTIN_PRODUCT_SKILLS_ENV,
    parse: parseBooleanEnv,
  },
);

export const stripBuiltinProductSkillsEnv: ConfigStripEnv<BuiltinProductSkillsConfig> = (
  value,
  raw,
  getEnv,
) => {
  if (getEnv === undefined) return value;
  if (parseBooleanEnv(getEnv(BUILTIN_PRODUCT_SKILLS_ENV)) === undefined) return value;
  return typeof raw === 'boolean' ? raw : undefined;
};

registerConfigSection(BUILTIN_PRODUCT_SKILLS_SECTION, BuiltinProductSkillsConfigSchema, {
  defaultValue: true,
  env: builtinProductSkillsEnvBindings,
  stripEnv: stripBuiltinProductSkillsEnv,
});

export function builtinProductSkillsEnabled(config: IConfigService): boolean {
  return config.get<BuiltinProductSkillsConfig>(BUILTIN_PRODUCT_SKILLS_SECTION) !== false;
}
