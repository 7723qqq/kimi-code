import type { TranscriptSkillActivation, TranscriptUserOrigin } from '../model/frame';
import type { TurnOrigin } from '../model/turn';

export const HIDDEN_USER_ORIGINS: ReadonlySet<string> = new Set([
  'injection',
  'system_trigger',
  'retry',
]);

export const TURN_OPENING_SYSTEM_TRIGGERS: ReadonlySet<string> = new Set([
  'goal_continuation',
  'subagent',
]);

export const MARKER_USER_ORIGINS: Readonly<Record<string, string>> = {
  skill_activation: 'skill',
  plugin_command: 'skill',
  compaction_summary: 'compaction',
};

export const MARKER_USER_ORIGIN_KINDS: ReadonlySet<string> = new Set(
  Object.keys(MARKER_USER_ORIGINS),
);

export const NON_USER_ORIGIN_KINDS: ReadonlySet<string> = new Set([
  ...HIDDEN_USER_ORIGINS,
  'compaction_summary',
]);

const TASK_ORIGIN_KINDS: ReadonlySet<string> = new Set([
  'task',
  'background_task',
  'task_notification',
]);

export type UserOriginClass =
  | 'user'
  | 'opening_trigger'
  | 'hidden'
  | 'marker'
  | 'slash'
  | 'task'
  | 'other';

export function classifyUserOrigin(origin: unknown): UserOriginClass {
  const payload = origin as { kind?: unknown; name?: unknown; trigger?: unknown } | undefined;
  const kind = payload?.kind;
  if (kind === undefined || kind === 'user') return 'user';
  if (typeof kind !== 'string') return 'other';
  if (kind === 'system_trigger') {
    return typeof payload?.name === 'string' && TURN_OPENING_SYSTEM_TRIGGERS.has(payload.name)
      ? 'opening_trigger'
      : 'hidden';
  }
  if (HIDDEN_USER_ORIGINS.has(kind)) return 'hidden';
  if (isUserSlashOrigin(payload)) return 'slash';
  if (MARKER_USER_ORIGIN_KINDS.has(kind)) return 'marker';
  if (TASK_ORIGIN_KINDS.has(kind)) return 'task';
  return 'other';
}

export function isUserSlashOrigin(
  origin: { readonly kind?: unknown; readonly trigger?: unknown } | null | undefined,
): boolean {
  return (
    (origin?.kind === 'skill_activation' || origin?.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

export function isVisibleTurnOrigin(origin: unknown): boolean {
  const payload = origin as { kind?: unknown; name?: unknown } | undefined;
  const kind = payload?.kind;
  if (kind === 'system_trigger') {
    return typeof payload?.name === 'string' && TURN_OPENING_SYSTEM_TRIGGERS.has(payload.name);
  }
  if (kind === 'skill_activation' || kind === 'plugin_command') {
    return isUserSlashOrigin(payload);
  }
  if (
    typeof kind === 'string' &&
    (HIDDEN_USER_ORIGINS.has(kind) || MARKER_USER_ORIGIN_KINDS.has(kind))
  ) {
    return false;
  }
  return true;
}

export function isUndoAnchorTurnOrigin(origin: unknown): boolean {
  const payload = origin as { kind?: unknown; trigger?: unknown } | undefined;
  if (payload?.kind === undefined || payload.kind === 'user') return true;
  return isUserSlashOrigin(payload);
}

export function mapTurnOrigin(origin: unknown): TurnOrigin {
  const candidate = origin as { kind?: unknown } | null | undefined;
  const kind = typeof candidate?.kind === 'string' ? candidate.kind : undefined;
  switch (kind) {
    case 'user':
      return projectTranscriptUserTurnOrigin(origin);
    case 'cron_job':
    case 'cron_missed': {
      const jobId = (candidate as { jobId?: unknown }).jobId;
      return {
        kind: 'cron',
        taskId: typeof jobId === 'string' ? jobId : undefined,
        payload: origin,
      };
    }
    case 'task':
    case 'background_task': {
      const taskId = (candidate as { taskId?: unknown }).taskId;
      return typeof taskId === 'string'
        ? { kind: 'task', taskId, payload: origin }
        : { kind: 'other', payload: origin };
    }
    case 'hook_result':
      return { kind: 'hook', payload: origin };
    case 'compaction_summary':
      return { kind: 'compaction', payload: origin };
    case 'shell_command':
      return { kind: 'user', payload: origin };
    case undefined:
    default:
      return { kind: 'other', payload: origin };
  }
}

export function projectTranscriptUserOrigin(origin: unknown): TranscriptUserOrigin | undefined {
  const candidate = origin as
    | {
        readonly kind?: unknown;
        readonly skillActivations?: unknown;
        readonly clientMetadata?: unknown;
        readonly trigger?: unknown;
        readonly skillName?: unknown;
        readonly skillArgs?: unknown;
      }
    | undefined;
  if (candidate?.kind !== 'user' && candidate?.kind !== 'skill_activation') return undefined;
  const clientMetadata = Array.isArray(candidate.clientMetadata)
    ? candidate.clientMetadata.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];
  if (candidate.kind === 'skill_activation') {
    if (candidate.trigger !== 'user-slash') return undefined;
    if (typeof candidate.skillName !== 'string' || candidate.skillName.length === 0)
      return undefined;
    return {
      kind: 'skill_activation',
      trigger: 'user-slash',
      skillName: candidate.skillName,
      skillArgs: typeof candidate.skillArgs === 'string' ? candidate.skillArgs : undefined,
      clientMetadata: clientMetadata.length > 0 ? clientMetadata : undefined,
    };
  }
  if (!Array.isArray(candidate.skillActivations) && clientMetadata.length === 0)
    return { kind: 'user' };
  const skillActivations = (
    Array.isArray(candidate.skillActivations) ? candidate.skillActivations : []
  ).flatMap((activation): TranscriptSkillActivation[] => {
    if (typeof activation !== 'object' || activation === null) return [];
    const value = activation as { readonly skillName?: unknown; readonly skillArgs?: unknown };
    if (typeof value.skillName !== 'string') return [];
    return [
      {
        skillName: value.skillName,
        skillArgs: typeof value.skillArgs === 'string' ? value.skillArgs : undefined,
      },
    ];
  });
  return {
    kind: 'user',
    clientMetadata: clientMetadata.length > 0 ? clientMetadata : undefined,
    skillActivations: skillActivations.length > 0 ? skillActivations : undefined,
  };
}

export function projectTranscriptUserTurnOrigin(origin: unknown): TurnOrigin {
  return { kind: 'user', payload: projectTranscriptUserOrigin(origin) ?? { kind: 'user' } };
}
