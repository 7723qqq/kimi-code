/**
 * Localized host-side config helpers — small v1-core utilities the SDK
 * surface re-exports (safe config file bootstrap, hook schema validation,
 * replay trimming). Copied so the SDK does not import `agent-core`.
 */
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

const DEFAULT_CONFIG_FILE_TEXT = `# ~/.kimi-code/config.toml
# Runtime settings for Kimi Code.
# This file starts empty so built-in defaults can apply.
# Login will populate managed Kimi provider and model entries.
`;

/** Create `filePath` (0600) with the default empty config when missing. */
export async function ensureConfigFile(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(DEFAULT_CONFIG_FILE_TEXT, 'utf-8');
  } catch (error) {
    if (isFileExistsError(error)) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

export const HOOK_EVENT_TYPES = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionResult',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'Interrupt',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Notification',
] as const;

export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

export const HookDefSchema = z
  .object({
    event: z.enum(HOOK_EVENT_TYPES),
    matcher: z.string().optional(),
    command: z.string().min(1),
    timeout: z.number().int().min(1).max(600).optional(),
  })
  .strict();

export type HookDefConfig = z.infer<typeof HookDefSchema>;

/**
 * Structural stand-in for the v1 `AgentReplayRecord` (the full type still
 * comes from the v1 forward in `#/types` until that surface is migrated).
 */
export interface UserTurnRecordLike {
  readonly type: string;
  readonly message?: {
    readonly role?: string;
    readonly origin?: {
      readonly kind?: string;
      readonly trigger?: string;
      readonly phase?: string;
      readonly name?: string;
    };
  };
}

export function isAgentReplayUserTurnRecord(record: UserTurnRecordLike): boolean {
  if (record.type !== 'message') return false;
  const { message } = record;
  if (message?.role !== 'user') return false;
  switch (message.origin?.kind) {
    case undefined:
    case 'user':
      return true;
    case 'skill_activation':
      return message.origin.trigger === 'user-slash';
    case 'plugin_command':
      return message.origin.trigger === 'user-slash';
    case 'shell_command':
      // A `!` command's input is a user-turn anchor; its output is not.
      return message.origin.phase === 'input';
    case 'system_trigger':
      // The goal driver fires one synthetic continuation prompt per goal turn
      // and the goal system counts those as turns, so replay trimming treats
      // them as turn boundaries (v1 parity); all other system triggers are
      // reminders that continue the current turn.
      return message.origin.name === 'goal_continuation';
    default:
      return false;
  }
}

export function limitAgentReplayByTurns<T extends UserTurnRecordLike>(
  records: readonly T[],
  maxTurns?: number,
): readonly T[] {
  if (maxTurns === undefined) return records;
  if (maxTurns <= 0) return [];
  const turnStarts = records.flatMap((record, index) =>
    isAgentReplayUserTurnRecord(record) ? [index] : [],
  );
  if (turnStarts.length <= maxTurns) return records;
  return records.slice(turnStarts[turnStarts.length - maxTurns]);
}
