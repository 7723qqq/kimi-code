/**
 * `goal` domain barrel — re-exports the goal contract (`goal`) and its scoped
 * service (`goalService`), plus a side-effect import of each goal tool so its
 * `registerTool(...)` call runs at module load. Importing this barrel wires
 * `IAgentGoalService` into the scope registry and adds the four goal tools
 * (`CreateGoal` / `GetGoal` / `SetGoalBudget` / `UpdateGoal`) to the tool
 * contribution list.
 */

import './tools/create-goal';
import './tools/get-goal';
import './tools/set-goal-budget';
import './tools/update-goal';

export * from './goal';
export * from './goalService';
export * from './types';
