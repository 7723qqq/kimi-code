// Cadence at which the tasks browser and its output / agent-activity viewers
// refresh while open: the task list and tails are re-read on every tick, so
// this bounds how stale a visible row can be.
export const TASKS_POLL_INTERVAL_MS = 1000;
