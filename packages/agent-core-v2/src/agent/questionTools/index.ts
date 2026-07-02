/**
 * `questionTools` domain barrel — side-effect imports the `AskUserQuestion`
 * tool so its `registerTool(...)` call runs at module load. Importing this
 * barrel adds `AskUserQuestion` to the tool contribution list.
 */

import './tools/ask-user';
