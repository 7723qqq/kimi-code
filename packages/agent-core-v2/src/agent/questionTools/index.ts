/**
 * `questionTools` domain barrel — side-effect imports the `AskUserQuestion`
 * tool so its `registerTool(...)` call runs at module load, and re-exports the
 * question task adapter. Importing this barrel adds
 * `AskUserQuestion` to the tool contribution list.
 */

import './tools/ask-user';

export * from './tools/question-task';
