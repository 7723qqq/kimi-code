/**
 * `toolRegistry` domain barrel — re-exports the per-agent tool registry
 * contract (`toolRegistry`), its scoped service (`toolRegistryService`), the
 * module-level `registerTool` contribution API (`toolContribution`), and the
 * Eager side-effect service that consumes contributions
 * (`builtinToolsRegistrar`). Importing this barrel registers the
 * `IAgentToolRegistryService` and `IAgentBuiltinToolsRegistrar` bindings into
 * the scope registry.
 */

export * from './toolRegistry';
export * from './toolRegistryService';
export * from './toolContribution';
export * from './builtinToolsRegistrar';
