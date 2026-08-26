export const BACKEND_CANNOT_COMBINE_WITH_RESUME =
  'Cannot use backend with resume — an external backend runs a fresh session in the external CLI; resume targets an existing in-process agent by id.';
export const BACKEND_CANNOT_COMBINE_WITH_SUBAGENT_TYPE =
  'Cannot use backend with subagent_type — external backends have no in-process agent profile. Omit subagent_type to use backend.';
export const BACKEND_CANNOT_COMBINE_WITH_MODEL =
  'Cannot use backend with model — external backends are configured through the [subagentBackend] config section instead of the model parameter.';
export const BACKEND_CANNOT_COMBINE_WITH_FORK =
  'Cannot use backend with fork — fork snapshots the in-process conversation history, which an external backend does not share.';

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
