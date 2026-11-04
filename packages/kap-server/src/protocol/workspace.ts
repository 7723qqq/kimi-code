import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';
import { z } from 'zod';

export const workspaceIdSchema = z
  .string()
  .regex(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$|^wm_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, {
    message: 'workspace_id must be a wd_<slug>_<hash12> or wm_<uuid> string',
  });

export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

export const workspaceKindSchema = z.enum(['managed', 'implicit']);

export const workspaceSchema = z.object({
  id: workspaceIdSchema,
  root: z.string().min(1),
  name: z.string().min(1).max(100),
  kind: workspaceKindSchema,
  additional_dirs: z.array(z.string()),
  created_at: isoDateTimeSchema,
  last_opened_at: isoDateTimeSchema,
  session_count: z.number().int().nonnegative(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceCreateSchema = z.object({
  root: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
  additional_dirs: z.array(z.string().min(1)).max(64).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export type WorkspaceCreate = z.infer<typeof workspaceCreateSchema>;

export const workspaceUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  additional_dirs: z.array(z.string().min(1)).max(64).optional(),
});

export type WorkspaceUpdate = z.infer<typeof workspaceUpdateSchema>;
