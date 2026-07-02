/**
 * `agentTool` domain barrel — re-exports the child-agent run contract and
 * helpers (`runChildAgent`), the `Agent` collaboration tool, the default
 * profiles, and the Agent-scoped registrar (`agentToolService`) plus its token.
 * Importing this barrel registers the `IAgentToolService` binding into the scope
 * registry.
 */

export * from './types';
export * from './runChildAgent';
export * from './agentToolServiceToken';
export * from './profiles';
export * from './agentToolService';
export {
  AgentTool,
  AgentToolInputSchema,
  AgentToolOutputSchema,
} from './agentTool';
export type {
  AgentToolInput,
  AgentToolOutput,
  AgentToolSubagentMap,
  AgentToolSubagentProfile,
} from './agentTool';
