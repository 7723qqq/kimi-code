/**
 * `/tower` — report tower status, toggle tower mode, or set the objective.
 *
 * Mirrors `tui/commands/tower.ts`. The v1 handler caches the mode on
 * `appState.towerMode`; the tui2 store has no such field, so the previous
 * effective mode is read from `session.getStatus()` instead (the setter is
 * idempotent engine-side and re-confirmed after toggling, same as v1).
 *
 * Status: REAL (tui2). Ported from `tui/commands/tower.ts`.
 */
import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { getLlmNotSetMessage, getNoActiveSessionMessage } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

// Mirror of `TOWER_STATUS_PROMPT` / `TOWER_TEARDOWN_PROMPT` in
// `tui/constant/kimi-tui.ts` (the tui2 constant module is outside this
// task's file scope).
const TOWER_STATUS_PROMPT =
  'Report the current tower status: call TowerStatus and give a compact summary.';
const TOWER_TEARDOWN_PROMPT =
  'Tear down the tower: call TowerTeardown and report what it did. It refuses to destroy dirty worktrees unless forced.';

export async function handleTowerCommand(host: SlashCommandHost, args: string): Promise<void> {
  const input = args.trim();
  const sub = input.toLowerCase();

  if (sub === 'on') {
    await applyTowerMode(host, true);
    return;
  }
  if (sub === 'off') {
    await applyTowerMode(host, false);
    return;
  }
  if (sub === '' || sub === 'status') {
    host.sendNormalUserInput(TOWER_STATUS_PROMPT);
    return;
  }
  if (sub === 'teardown') {
    host.sendNormalUserInput(TOWER_TEARDOWN_PROMPT);
    return;
  }

  await startTowerObjective(host, input);
}

async function startTowerObjective(host: SlashCommandHost, objective: string): Promise<void> {
  // Validate prompt prerequisites before mutating the mode — otherwise a
  // rejected objective (no model configured) would leave tower on with the
  // next ordinary prompt unexpectedly running under the tower injection.
  if (host.state.appState.model.trim().length === 0) {
    host.showError(getLlmNotSetMessage());
    return;
  }
  const result = await setTowerMode(host, true);
  if (!result.ok) return;
  if (!result.wasActive) host.showNotice('Tower mode: ON');
  host.sendNormalUserInput(objective);
}

async function applyTowerMode(host: SlashCommandHost, enabled: boolean): Promise<void> {
  const result = await setTowerMode(host, enabled);
  if (!result.ok) return;
  if (result.wasActive === enabled) {
    host.showStatus(`Tower mode is already ${enabled ? 'on' : 'off'}.`);
    return;
  }
  host.showNotice(enabled ? 'Tower mode: ON' : 'Tower mode: OFF');
}

async function setTowerMode(
  host: SlashCommandHost,
  enabled: boolean,
): Promise<{ ok: boolean; wasActive: boolean }> {
  const session = await requireSessionEnsured(host);
  if (session === undefined) return { ok: false, wasActive: false };
  try {
    const wasActive = (await session.getStatus()).towerMode ?? false;
    await session.setTowerMode(enabled);
    // The engine may silently refuse entry (flag off, feature not assembled
    // until a restart, another session owning the workspace tower) — confirm
    // the mode actually took before reporting success or letting an objective
    // ride on it.
    const effective = (await session.getStatus()).towerMode ?? false;
    if (effective !== enabled) {
      host.showError(
        enabled
          ? 'Tower mode could not be enabled — another session owns this workspace tower, or the experiment is off / was just turned on and needs a restart.'
          : 'Tower mode could not be disabled.',
      );
      return { ok: false, wasActive: effective };
    }
    return { ok: true, wasActive };
  } catch (error) {
    host.showError(
      `Failed to ${enabled ? 'enable' : 'disable'} tower mode: ${formatErrorMessage(error)}`,
    );
    return { ok: false, wasActive: false };
  }
}

async function requireSessionEnsured(host: SlashCommandHost): Promise<Session | undefined> {
  if (host.session !== undefined) return host.session;
  if (!host.engineV2) {
    host.showError(getNoActiveSessionMessage());
    return undefined;
  }
  // v2 session-less: lazy-create the session, then toggle — the same path
  // the first prompt takes.
  return host.ensureSession();
}
