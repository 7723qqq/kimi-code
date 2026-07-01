/**
 * `globalSkillCatalog` domain (L5) — builtin skill registration.
 *
 * Registers the code-defined builtin skills into an in-memory catalog. Builtin
 * skills are constants (not discovered from storage), so they bypass the
 * `ISkillCatalogStore` and are registered directly by the global catalog.
 */

import type { InMemorySkillCatalog } from '#/app/globalSkillCatalog/registry';
import { CUSTOM_THEME_SKILL } from './custom-theme';
import { IMPORT_FROM_CC_CODEX_SKILL } from './import-from-cc-codex';
import { MCP_CONFIG_SKILL } from './mcp-config';
import {
  SUB_SKILL_CONSOLIDATE,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
} from './sub-skill';
import { UPDATE_CONFIG_SKILL } from './update-config';
import { WRITE_GOAL_SKILL } from './write-goal';

export function registerBuiltinSkills(registry: InMemorySkillCatalog): void {
  registry.registerBuiltinSkill(MCP_CONFIG_SKILL);
  registry.registerBuiltinSkill(IMPORT_FROM_CC_CODEX_SKILL);
  registry.registerBuiltinSkill(UPDATE_CONFIG_SKILL);
  registry.registerBuiltinSkill(CUSTOM_THEME_SKILL);
  registry.registerBuiltinSkill(WRITE_GOAL_SKILL);
  registry.registerBuiltinSkill(SUB_SKILL_PARENT);
  registry.registerBuiltinSkill(SUB_SKILL_REVIEW);
  registry.registerBuiltinSkill(SUB_SKILL_CONSOLIDATE);
}

export {
  CUSTOM_THEME_SKILL,
  IMPORT_FROM_CC_CODEX_SKILL,
  MCP_CONFIG_SKILL,
  SUB_SKILL_CONSOLIDATE,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
  UPDATE_CONFIG_SKILL,
  WRITE_GOAL_SKILL,
};
