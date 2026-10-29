import { z } from 'zod';

export const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

export const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));
