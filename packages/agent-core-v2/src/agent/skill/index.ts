/**
 * `skill` domain barrel — re-exports the agent skill contract and its
 * Agent-scope service, plus a side-effect import of the `Skill` collaboration
 * tool so its `registerTool(...)` call runs at module load. Importing this
 * barrel wires `IAgentSkillService` into the scope registry and adds `Skill`
 * to the tool contribution list.
 */

import './tools/skill';

export * from './skill';
export * from './skillService';
