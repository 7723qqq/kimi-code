import { z } from 'zod';

export const cronTaskSchema = z.object({
  id: z.string(),
  cron: z.string(),
  human_schedule: z.string().optional(),
  prompt: z.string(),
  created_at: z.number(),
  recurring: z.boolean().optional(),
  last_fired_at: z.number().optional(),
  next_fire_at: z.number().nullable().optional(),
});
export type CronTask = z.infer<typeof cronTaskSchema>;

export const listCronTasksResponseSchema = z.object({
  tasks: z.array(cronTaskSchema),
});
export type ListCronTasksResponse = z.infer<typeof listCronTasksResponseSchema>;

export const createCronTaskRequestSchema = z.object({
  cron: z.string().min(1),
  prompt: z.string().min(1),
  recurring: z.boolean().optional(),
});
export type CreateCronTaskRequest = z.infer<typeof createCronTaskRequestSchema>;

export const createCronTaskResponseSchema = cronTaskSchema;
export type CreateCronTaskResponse = z.infer<typeof createCronTaskResponseSchema>;

export const deleteCronTaskResultSchema = z.object({
  deleted: z.boolean(),
});
export type DeleteCronTaskResult = z.infer<typeof deleteCronTaskResultSchema>;
