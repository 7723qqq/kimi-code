import { parseSkillText } from '#/features/skill/catalog/parser';
import type { SkillDefinition } from '#/features/skill/catalog/types';

import CRAFT_ANYTHING_BODY from './craft-anything.md?raw';

const PSEUDO_PATH = 'builtin://craft-anything';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/craft-anything.md',
  skillDirName: 'craft-anything',
  source: 'builtin',
  text: CRAFT_ANYTHING_BODY,
});

export const CRAFT_ANYTHING_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
