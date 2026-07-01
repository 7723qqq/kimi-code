/**
 * `globalSkillCatalog` domain (L5) — builtin `custom-theme` skill definition.
 */

import type { SkillDefinition } from '#/app/globalSkillCatalog/types';
import { parseSkillText } from '#/app/globalSkillCatalog/parser';
import CUSTOM_THEME_BODY from './custom-theme.md?raw';

const PSEUDO_PATH = 'builtin://custom-theme';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/custom-theme.md',
  skillDirName: 'custom-theme',
  source: 'builtin',
  text: CUSTOM_THEME_BODY,
});

export const CUSTOM_THEME_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
    disableModelInvocation: true,
  },
};
