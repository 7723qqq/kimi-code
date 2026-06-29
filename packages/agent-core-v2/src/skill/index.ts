/**
 * `skill` domain barrel — re-exports the skill contract (`skill`) and its
 * concrete catalog (`registry`) plus scoped service (`skillService`).
 * Importing this barrel registers the `IAgentSkillService` binding into the
 * scope registry.
 */

export * from './skill';
export * from './types';
export * from './registry';
export * from './skillService';
