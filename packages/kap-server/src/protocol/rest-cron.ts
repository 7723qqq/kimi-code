/**
 * Wire schemas for the `/sessions/{session_id}/cron*` REST surface — the
 * session's cron task set (`ISessionCronService`).
 *
 *   GET    /sessions/{session_id}/cron            data: {tasks[]}
 *   DELETE /sessions/{session_id}/cron/{task_id}  data: {deleted:true}
 */

import { z } from 'zod';

export const cronTaskSchema = z.object({
  id: z.string(),
  cron: z.string(),
  prompt: z.string(),
  /** Milliseconds since the epoch (the engine clock's unit). */
  created_at: z.number(),
  recurring: z.boolean().optional(),
  /** Milliseconds since the epoch, when the task fired at least once. */
  last_fired_at: z.number().optional(),
  /** Milliseconds since the epoch, or null when the expression never fires
   *  again within the engine's horizon. Absent when unknown (no next fire
   *  computation was done). */
  next_fire_at: z.number().nullable().optional(),
});
export type CronTask = z.infer<typeof cronTaskSchema>;

export const listCronTasksResponseSchema = z.object({
  tasks: z.array(cronTaskSchema),
});
export type ListCronTasksResponse = z.infer<typeof listCronTasksResponseSchema>;

export const deleteCronTaskResultSchema = z.object({
  deleted: z.boolean(),
});
export type DeleteCronTaskResult = z.infer<typeof deleteCronTaskResultSchema>;
