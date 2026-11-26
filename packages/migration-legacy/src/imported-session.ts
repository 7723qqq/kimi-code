import { existsSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SESSION_META_VERSION } from '@moonshot-ai/agent-core-v2';

import { targetSessionsDir } from './paths.js';
import { ensureSessionIndexEntry } from './session-index.js';
import { writeMainAgentWire } from './sessions/wire-writer.js';

export interface ImportedSessionMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
}

export interface ImportedSessionInput {
  readonly targetHome: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly workDir: string;
  readonly environmentCwd?: string;
  readonly title: string;
  readonly lastPrompt: string;
  readonly updatedAtMs: number;
  readonly messages: readonly ImportedSessionMessage[];
  readonly custom: Readonly<Record<string, unknown>>;
}

/** Directory of an imported session; conversion attachments belong in its `attachments` child. */
export function importedSessionDir(targetHome: string, projectId: string, sessionId: string): string {
  return join(targetSessionsDir(targetHome), projectId, sessionId);
}

export function isSessionImported(targetHome: string, sessionId: string): boolean {
  const sessionsDir = targetSessionsDir(targetHome);
  if (!existsSync(sessionsDir)) return false;
  return readdirSync(sessionsDir).some((projectId) =>
    existsSync(join(importedSessionDir(targetHome, projectId, sessionId), 'state.json')),
  );
}

/**
 * Write a session converted from another tool as an ordinary kimi-code session.
 *
 * The main agent wire gets the same synthesized turn records as migrated
 * kimi-cli sessions. `state.json` is written last, so a directory without it
 * is an interrupted write the caller can remove and retry. The generated
 * title kind keeps the imported title when the session is continued.
 */
export async function writeImportedSession(input: ImportedSessionInput): Promise<string> {
  const sessionDir = importedSessionDir(input.targetHome, input.projectId, input.sessionId);
  await writeMainAgentWire(sessionDir, {
    createdAtMs: input.updatedAtMs,
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
      toolCalls: [],
    })),
  });
  const state = {
    id: input.sessionId,
    version: SESSION_META_VERSION,
    cwd: input.workDir,
    environmentCwd: input.environmentCwd,
    createdAt: input.updatedAtMs,
    updatedAt: input.updatedAtMs,
    archived: false,
    title: input.title,
    titleKind: 'generated',
    isCustomTitle: false,
    lastPrompt: input.lastPrompt.slice(0, 200),
    lastTurnReason: 'completed',
    agents: {
      main: { homedir: join(sessionDir, 'agents', 'main'), type: 'main', parentAgentId: null },
    },
    custom: input.custom,
  };
  await writeFile(join(sessionDir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
  await ensureSessionIndexEntry(input.targetHome, {
    sessionId: input.sessionId,
    projectRoot: input.projectRoot,
    sessionDir,
    workDir: input.workDir,
  });
  return sessionDir;
}
