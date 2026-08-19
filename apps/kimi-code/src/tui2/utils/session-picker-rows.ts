/**
 * TUI2 session picker rows.
 *
 * Mirrors `tui/utils/session-picker-rows.ts` with imports converged onto the
 * tui2 tree.
 *
 * Status: REAL (tui2). Mirrors `tui/utils/session-picker-rows.ts`.
 */

import type { SessionSummary } from '@moonshot-ai/kimi-code-sdk';

import type { SessionRow } from '../components/dialogs/session-picker';

export function sessionRowsForPicker(
  sessions: readonly SessionSummary[],
  currentSessionId: string,
  currentSessionHasContent: boolean,
): SessionRow[] {
  return sessions
    .filter((session) => currentSessionHasContent || session.id !== currentSessionId)
    .map((session) => ({
      id: session.id,
      title: session.title ?? null,
      last_prompt: session.lastPrompt ?? null,
      work_dir: session.workDir,
      updated_at: session.updatedAt ?? session.createdAt ?? 0,
      metadata: session.metadata,
    }));
}
