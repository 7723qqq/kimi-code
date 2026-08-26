/**
 * Tests for `tui2/commands/migration-screen.tsx` — the opentui migration
 * flow. Verifies the decision state machine (skip / later / never / now)
 * drives the editor-replacement slot and reports the final result.
 */
import { describe, expect, it, vi } from 'vitest'

import type { MigrationPlan, MigrationReport } from '@moonshot-ai/migration-legacy'

import { runMigrationFlow } from '../../src/tui2/commands/migration-screen'
import type { SlashCommandHost } from '../../src/tui2/commands/dispatch'
import type { Tui2Store } from '../../src/tui2/state'

type Replacement = { component: unknown; props: Record<string, unknown> }

function makeHost(): { host: SlashCommandHost; replacement: () => Replacement | undefined } {
  let replacement: Replacement | undefined
  const store = {
    state: {} as never,
    setState: (_key: never, _value: unknown) => {
      // Probe: `mountEditorReplacement` writes `{ component, props }` into
      // `editorReplacement`; commands also use `setState('editorReplacement', undefined)`
      // to tear it down. We just record the latest value.
      replacement = _value as Replacement | undefined
    },
  } as unknown as Tui2Store
  return {
    host: { store } as SlashCommandHost,
    replacement: () => replacement,
  }
}

/** Simulate the user pressing Enter on the currently mounted dialog. */
function selectCurrent(replacement: () => Replacement | undefined, value: string): void {
  const r = replacement()
  if (r === undefined) throw new Error('no editor replacement mounted')
  ;(r.props['onSelect'] as (v: string) => void)(value)
}

/** Simulate the user pressing Esc on the currently mounted dialog. */
function cancelCurrent(replacement: () => Replacement | undefined): void {
  const r = replacement()
  if (r === undefined) throw new Error('no editor replacement mounted')
  ;(r.props['onCancel'] as () => void)()
}

/** Finish the result dialog (Enter), which resolves the flow promise. */
function finishResult(replacement: () => Replacement | undefined): void {
  const r = replacement()
  if (r === undefined) throw new Error('no editor replacement mounted')
  ;(r.props['onDone'] as () => void)()
}

const plan: MigrationPlan = {
  sourceHome: 'C:/x/.kimi',
  hasConfig: true,
  hasMcp: false,
  hasUserHistory: false,
  totalSessions: 2,
} as MigrationPlan

const report: MigrationReport = {
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:01.000Z',
  migratorVersion: 'test',
  source: 'C:/x/.kimi',
  target: 'C:/y/.kimi-code',
  summary: {
    config: {
      migrated: true,
      tuiExtracted: false,
      droppedProviders: [],
      droppedModels: [],
      droppedKeys: [],
      configConflicts: [],
      wroteSiblingDueToConflict: false,
      wroteTuiSibling: false,
      migratedHooks: 0,
      droppedHooks: 0,
      siblingContents: { providers: [], models: [], hooks: 0 },
    },
    mcp: { mergedServers: [], keptNewForConflicts: [], droppedServers: [], wroteSiblingDueToConflict: false },
    userHistory: { copied: 0, skippedExisting: 0, failures: [] },
    skills: { copied: 0, skippedExisting: 0, failures: [] },
    sessions: {
      scope: 'config-only',
      bucketsScanned: 0,
      bucketsSkippedNonlocalKaos: 0,
      bucketsSkippedNoWorkdirFound: 0,
      sessionsAttempted: 0,
      sessionsMigrated: 0,
      sessionsAlreadyMigrated: 0,
      sessionsSkippedPlaceholder: 0,
      sessionsSkippedEmpty: 0,
      sessionsSkippedMalformed: 0,
      sessionsFailed: [],
      sessionsConflicts: [],
      sessionsDebrisArchived: [],
    },
  },
  notices: {
    mcpOauthServersRequiringReauth: [],
    oauthLoginsRequiringRelogin: [],
    detectedPlugins: [],
    configConflictNotice: null,
    tuiConflictNotice: null,
  },
}

describe('runMigrationFlow', () => {
  it('skips the gate and runs migration when skipDecisionStep is set', async () => {
    const { host, replacement } = makeHost()
    const mocked = vi.fn(async () => report)
    const promise = runMigrationFlow({
      host,
      plan,
      sourceHome: plan.sourceHome,
      targetHome: 'C:/y/.kimi-code',
      skipDecisionStep: true,
      runMigration: mocked,
    })

    // wait one microtask so the first editor replacement (ask2) mounts
    await Promise.resolve()
    await Promise.resolve()

    // ask2 is mounted; choose "all-sessions"
    expect(replacement()).toBeDefined()
    selectCurrent(replacement, 'all-sessions')

    // progress + run; result dialog mounts after the mocked run resolves
    await Promise.resolve()
    await Promise.resolve()
    finishResult(replacement)

    const result = await promise
    expect(mocked).toHaveBeenCalledTimes(1)
    expect(result.decision).toBe('now')
    expect(result.migrated).toBe(true)
  })

  it('returns later on Esc at the first prompt', async () => {
    const { host, replacement } = makeHost()
    const promise = runMigrationFlow({
      host,
      plan,
      sourceHome: plan.sourceHome,
      targetHome: 'C:/y/.kimi-code',
      runMigration: vi.fn(),
    })
    await Promise.resolve()
    cancelCurrent(replacement)
    await expect(promise).resolves.toEqual({ decision: 'later' })
  })

  it('returns never when the user picks the keep-old-data option', async () => {
    const { host, replacement } = makeHost()
    const promise = runMigrationFlow({
      host,
      plan,
      sourceHome: plan.sourceHome,
      targetHome: 'C:/y/.kimi-code',
      runMigration: vi.fn(),
    })
    await Promise.resolve()
    selectCurrent(replacement, 'never')
    await expect(promise).resolves.toEqual({ decision: 'never' })
  })

  it('persists a failure through the result dialog', async () => {
    const { host, replacement } = makeHost()
    const mocked = vi.fn(async () => {
      throw new Error('boom')
    })
    const promise = runMigrationFlow({
      host,
      plan,
      sourceHome: plan.sourceHome,
      targetHome: 'C:/y/.kimi-code',
      skipDecisionStep: true,
      runMigration: mocked,
    })
    await Promise.resolve()
    selectCurrent(replacement, 'config-only')
    await Promise.resolve()
    await Promise.resolve()
    // Failure dialog is mounted; Enter finishes with migrated: false.
    finishResult(replacement)
    const result = await promise
    expect(result.decision).toBe('now')
    expect(result.migrated).toBe(false)
  })
})