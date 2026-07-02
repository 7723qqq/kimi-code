/**
 * `swarm` domain barrel — re-exports the swarm contract (`swarm`) and its
 * scoped service (`swarmService`), plus the `swarmTools` registrar. Importing
 * this barrel registers the `IAgentSwarmService` and `IAgentSwarmToolsService`
 * bindings into the scope registry.
 */

export * from './swarm';
export * from './swarmService';
export * from './swarmTools';
export * from './swarmToolsService';
