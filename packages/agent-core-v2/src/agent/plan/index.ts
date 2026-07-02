/**
 * `plan` domain barrel — re-exports the plan contract (`plan`) and its scoped
 * service (`planService`), plus the `planTools` registrar. Importing this barrel
 * registers the `IAgentPlanService` and `IAgentPlanToolsService` bindings into the
 * scope registry.
 */

export * from './plan';
export * from './planService';
export * from './planTools';
export * from './planToolsService';
