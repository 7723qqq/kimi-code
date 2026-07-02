/**
 * `plan` domain barrel — re-exports the plan contract (`plan`) and its scoped
 * service (`planService`), plus a side-effect import of each plan tool so its
 * `registerTool(...)` call runs at module load. Importing this barrel wires
 * `IAgentPlanService` into the scope registry and adds `EnterPlanMode` /
 * `ExitPlanMode` to the tool contribution list.
 */

import './tools/enter-plan-mode';
import './tools/exit-plan-mode';

export * from './plan';
export * from './planService';
