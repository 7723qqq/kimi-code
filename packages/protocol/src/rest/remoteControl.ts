/**
 * GET /v1/remote-control
 * POST /v1/remote-control
 */
import { z } from 'zod';

export const remoteControlStateSchema = z.enum(['off', 'starting', 'on', 'stopping']);
export type RemoteControlState = z.infer<typeof remoteControlStateSchema>;

export const remoteControlStatusSchema = z.object({
  enabled: z.boolean(),
  state: remoteControlStateSchema,
  url: z.string().optional(),
  device_id: z.string().optional(),
  device_name: z.string().optional(),
  error: z.string().optional(),
});
export type RemoteControlStatus = z.infer<typeof remoteControlStatusSchema>;

export const setRemoteControlRequestSchema = z.object({
  enabled: z.boolean(),
});
export type SetRemoteControlRequest = z.infer<typeof setRemoteControlRequestSchema>;
