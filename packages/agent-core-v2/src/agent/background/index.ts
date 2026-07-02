/**
 * `background` domain barrel — re-exports the background contract
 * (`background`) and its scoped service (`backgroundService`), plus a
 * side-effect import of each background tool so its `registerTool(...)` call
 * runs at module load. Importing this barrel wires `IAgentBackgroundService`
 * into the scope registry and adds the three tools (`TaskList` / `TaskOutput`
 * / `TaskStop`) to the tool contribution list.
 */

import './configSection';
import './tools/task-list';
import './tools/task-output';
import './tools/task-stop';

export * from './background';
export * from './backgroundService';
