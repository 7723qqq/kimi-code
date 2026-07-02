/**
 * `goal` domain barrel — re-exports the goal contract (`goal`) and its scoped
 * service (`goalService`), plus the `goalTools` registrar. Importing this barrel
 * registers the `IAgentGoalService` and `IAgentGoalToolsService` bindings into the
 * scope registry.
 */

export * from './goal';
export * from './goalService';
export * from './goalTools';
export * from './goalToolsService';
export * from './types';
