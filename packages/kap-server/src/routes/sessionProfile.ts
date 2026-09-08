import {
  ErrorCodes,
  Error2,
  ISessionContext,
  ISessionMetadata,
  resumeSessionById,
  type Scope,
} from '#/compat/core.js';
import type { SessionWireFields } from '#/compat/core.js';

export async function updateSessionProfile(
  core: Scope,
  sessionId: string,
  body: {
    title?: string;
    metadata?: Record<string, unknown>;
    permission_rules?: unknown;
  },
): Promise<SessionWireFields> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const metadata = session.accessor.get(ISessionMetadata);

  if (typeof body.title === 'string') {
    await metadata.setTitle(body.title);
  }

  const metadataPatch = body.metadata;
  if (metadataPatch !== undefined && Object.keys(metadataPatch).length > 0) {
    await metadata.update({ custom: { ...(metadataPatch as Record<string, unknown>) } });
  }

  const meta = await metadata.read();
  const ctx = session.accessor.get(ISessionContext);
  return {
    id: meta.id,
    workspaceId: ctx.workspaceId,
    root: ctx.cwd,
    title: meta.title,
    lastPrompt: meta.lastPrompt,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    archived: meta.archived,
    archivedAt: meta.archivedAt,
    custom: meta.custom,
  };
}
