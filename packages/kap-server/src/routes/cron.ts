
import {
  AgentCron,
  IAgentLifecycleService,
  MAIN_AGENT_ID,
  resumeSessionById,
  ensureMainAgent,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { cronToHuman, parseCronExpression } from '@moonshot-ai/agent-core-v2/features/cron/internal/cron-expr';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  createCronTaskRequestSchema,
  createCronTaskResponseSchema,
  deleteCronTaskResultSchema,
  listCronTasksResponseSchema,
} from '../protocol/rest-cron';

interface CronRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const sessionAndTaskIdParamSchema = z.object({
  session_id: z.string().min(1),
  task_id: z.string().min(1),
});

export function registerCronRoutes(app: CronRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/cron',
      params: sessionIdParamSchema,
      success: { data: listCronTasksResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List the cron tasks scheduled for a session',
      tags: ['cron'],
      operationId: 'listCronTasks',
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const handle = await resumeSessionById(core.accessor, session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const manager = handle.accessor.get(IAgentLifecycleService);
      const mainContext = manager.get(MAIN_AGENT_ID);
      const cron =
        mainContext === undefined ? undefined : manager.resolve(mainContext, AgentCron);
      const tasks =
        cron === undefined
          ? []
          : cron.list().map((task) => {
              const next = cron.getNextFireForTask(task.id);
              let humanSchedule: string | undefined;
              try {
                humanSchedule = cronToHuman(parseCronExpression(task.cron));
              } catch {
              }
              return {
                id: task.id,
                cron: task.cron,
                ...(humanSchedule !== undefined ? { human_schedule: humanSchedule } : {}),
                prompt: task.prompt,
                created_at: task.createdAt,
                ...(task.recurring !== undefined ? { recurring: task.recurring } : {}),
                ...(task.lastFiredAt !== undefined ? { last_fired_at: task.lastFiredAt } : {}),
                ...(next !== null ? { next_fire_at: next } : { next_fire_at: null }),
              };
            });
      reply.send(okEnvelope({ tasks }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<CronRouteHost['get']>[2],
  );

  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/cron',
      params: sessionIdParamSchema,
      body: createCronTaskRequestSchema,
      success: { data: createCronTaskResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.VALIDATION_FAILED]: {},
      },
      description: 'Schedule a cron task for a session (REST analogue of the CronCreate tool)',
      tags: ['cron'],
      operationId: 'createCronTask',
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const handle = await resumeSessionById(core.accessor, session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const { cron, prompt, recurring } = req.body as {
        cron: string;
        prompt: string;
        recurring?: boolean;
      };
      let parsed;
      try {
        parsed = parseCronExpression(cron);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
        return;
      }
      const manager = handle.accessor.get(IAgentLifecycleService);
      let mainContext = manager.get(MAIN_AGENT_ID);
      if (mainContext === undefined) {
        mainContext = await ensureMainAgent(handle);
      }
      const cronSvc = manager.resolve(mainContext, AgentCron);
      const task = cronSvc.addTask({ cron, prompt, recurring: recurring ?? true });
      const next = cronSvc.getNextFireForTask(task.id);
      const taskWire = {
        id: task.id,
        cron: task.cron,
        human_schedule: cronToHuman(parsed),
        prompt: task.prompt,
        created_at: task.createdAt,
        ...(task.recurring !== undefined ? { recurring: task.recurring } : {}),
        ...(task.lastFiredAt !== undefined ? { last_fired_at: task.lastFiredAt } : {}),
        ...(next !== null ? { next_fire_at: next } : { next_fire_at: null }),
      };
      requestLog(req)?.info({ task_id: task.id, cron }, 'cron task created');
      reply.send(okEnvelope(taskWire, req.id));
    },
  );
  app.post(
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<CronRouteHost['post']>[2],
  );

  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/sessions/{session_id}/cron/{task_id}',
      params: sessionAndTaskIdParamSchema,
      success: { data: deleteCronTaskResultSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TASK_NOT_FOUND]: {},
      },
      description: 'Remove a cron task from a session',
      tags: ['cron'],
      operationId: 'deleteCronTask',
    },
    async (req, reply) => {
      const { session_id, task_id } = req.params;
      const handle = await resumeSessionById(core.accessor, session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const manager = handle.accessor.get(IAgentLifecycleService);
      const mainContext = manager.get(MAIN_AGENT_ID);
      const cron =
        mainContext === undefined ? undefined : manager.resolve(mainContext, AgentCron);
      if (cron?.getTask(task_id) === undefined) {
        reply.send(
          errEnvelope(ErrorCode.TASK_NOT_FOUND, `cron task ${task_id} does not exist`, req.id),
        );
        return;
      }
      const removed = cron?.removeTasks([task_id]) ?? [];
      requestLog(req)?.info({ task_id }, 'cron task removed');
      reply.send(okEnvelope({ deleted: removed.length === 1 }, req.id));
    },
  );
  app.delete(
    deleteRoute.path,
    deleteRoute.options,
    deleteRoute.handler as Parameters<CronRouteHost['delete']>[2],
  );
}
