/**
 * `toolRegistry` domain barrel — re-exports the per-agent tool registry
 * contract (`toolRegistry`) and its scoped service (`toolRegistryService`).
 * Importing this barrel registers the `IAgentToolRegistryService` binding into the scope
 * registry.
 */

export * from './toolRegistry';
export * from './toolRegistryService';
