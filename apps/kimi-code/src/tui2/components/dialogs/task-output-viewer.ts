/**
 * TUI2 task-output-viewer — forwarding layer.
 *
 * Status: REAL (tui2). Forwards to `task-output-viewer.tsx`.
 */
export * from './task-output-viewer.tsx';
export const statusColor = (status: string): string => status;
