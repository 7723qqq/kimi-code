import { z } from 'zod';

import { booleanQueryParam } from './query-params';
import { taskSchema, taskStatusSchema } from './task';

export const listTasksQuerySchema = z
  .object({
    status: taskStatusSchema.optional(),
  })
  .strict();
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const listTasksResponseSchema = z.object({
  items: z.array(taskSchema),
});
export type ListTasksResponse = z.infer<typeof listTasksResponseSchema>;

export const getTaskQuerySchema = z
  .object({
    with_output: booleanQueryParam,
    output_bytes: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();
export type GetTaskQuery = z.infer<typeof getTaskQuerySchema>;

export const getTaskResponseSchema = taskSchema;
export type GetTaskResponse = z.infer<typeof getTaskResponseSchema>;

export const cancelTaskResultSchema = z.object({
  cancelled: z.literal(true),
});
export type CancelTaskResult = z.infer<typeof cancelTaskResultSchema>;

export const detachTaskResultSchema = z.object({
  detached: z.boolean(),
  status: taskStatusSchema,
});
export type DetachTaskResult = z.infer<typeof detachTaskResultSchema>;

export const taskAlreadyFinishedDataSchema = z.object({
  cancelled: z.literal(false),
});
export type TaskAlreadyFinishedData = z.infer<typeof taskAlreadyFinishedDataSchema>;
