import {
  BACKEND_CANNOT_COMBINE_WITH_FORK,
  BACKEND_CANNOT_COMBINE_WITH_MODEL,
  BACKEND_CANNOT_COMBINE_WITH_RESUME,
  BACKEND_CANNOT_COMBINE_WITH_SUBAGENT_TYPE,
} from '#/agent/tools/agent/agent';

export interface BackendCompatInputLike {
  readonly backend?: string;
  readonly fork?: boolean;
  readonly resume?: string;
  readonly subagent_type?: string;
  readonly model?: string;
}

export function backendIncompatibility(args: BackendCompatInputLike): string | undefined {
  if (args.backend === undefined || args.backend.length === 0) return undefined;

  if (args.resume !== undefined && args.resume.trim().length > 0) {
    return BACKEND_CANNOT_COMBINE_WITH_RESUME;
  }
  if (args.subagent_type !== undefined && args.subagent_type.length > 0) {
    return BACKEND_CANNOT_COMBINE_WITH_SUBAGENT_TYPE;
  }
  if (args.model !== undefined && args.model.length > 0) {
    return BACKEND_CANNOT_COMBINE_WITH_MODEL;
  }
  if (args.fork === true) {
    return BACKEND_CANNOT_COMBINE_WITH_FORK;
  }
  return undefined;
}
