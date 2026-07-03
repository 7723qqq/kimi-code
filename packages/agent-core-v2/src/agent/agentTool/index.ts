/**
 * `agentTool` domain barrel — re-exports the subagent lifecycle hook service
 * contract (`agentToolServiceToken`) and its scoped service
 * (`agentToolService`). Importing this barrel registers the
 * `IAgentToolService` binding into the scope registry.
 */

export * from './agentToolServiceToken';
export * from './agentToolService';
