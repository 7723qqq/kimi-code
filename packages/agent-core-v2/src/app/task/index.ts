/**
 * `task` domain barrel — re-exports the task contract and implementation.
 * Importing this barrel registers the `ITaskService` binding.
 */

export * from './task';
import './taskService';
export { TaskService } from './taskService';
