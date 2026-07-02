/**
 * `swarm` domain barrel — re-exports the swarm contract (`swarm`) and its
 * scoped service (`swarmService`), plus a side-effect import of the
 * `AgentSwarm` collaboration tool so its `registerTool(...)` call runs at
 * module load. Importing this barrel wires `IAgentSwarmService` into the scope
 * registry and adds `AgentSwarm` to the tool contribution list.
 */

import './tools/agent-swarm';

export * from './swarm';
export * from './swarmService';
