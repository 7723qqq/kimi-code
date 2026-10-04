import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { writeReport } from '../src/report.js';
import type { MigrationReport } from '../src/types.js';

let tgt: string;
beforeEach(async () => {
  tgt = await mkdtemp(join(tmpdir(), 'rpt-'));
});
afterEach(async () => {
  await rm(tgt, { recursive: true, force: true });
});

describe('writeReport', () => {
  it('serializes the report at <target>/migration-report.json', async () => {
    const report: MigrationReport = {
      startedAt: 's',
      completedAt: 'e',
      migratorVersion: '0.1.1',
      source: '/x',
      target: tgt,
      summary: {
        config: {
          migrated: false,
          tuiExtracted: false,
          droppedProviders: [],
          droppedModels: [],
          droppedKeys: [],
          configConflicts: [],
          wroteSiblingDueToConflict: false,
          wroteTuiSibling: false,
          migratedHooks: 0,
          droppedHooks: 0,
          sourceUnreadable: false,
          deviceIdCopied: false,
          siblingContents: { providers: [], models: [], hooks: 0 },
        },
        mcp: {
          mergedServers: [],
          keptNewForConflicts: [],
          droppedServers: [],
          wroteSiblingDueToConflict: false,
          sourceUnreadable: false,
        },
        userHistory: {
          copied: 0,
          skippedExisting: 0,
          failures: [{ sourcePath: '/x/bad-history.jsonl', reason: 'EACCES' }],
        },
        skills: { copied: 0, skippedExisting: 0, failures: [] },
        plans: { copied: 0, skippedExisting: 0 },
        sessions: {
          scope: 'all',
          bucketsScanned: 0,
          bucketsSkippedNonlocalKaos: 0,
          bucketsSkippedNoWorkdirFound: 0,
          sessionsAttempted: 0,
          sessionsMigrated: 0,
          sessionsAlreadyMigrated: 0,
          sessionsRepaired: 0,
          sessionsSkippedPlaceholder: 0,
          sessionsSkippedEmpty: 0,
          sessionsSkippedMalformed: 0,
          sessionsFailed: [],
          sessionsConflicts: [],
          sessionsDebrisArchived: [
            { targetPath: '/t/ses_x', archivedPath: '/t/ses_x.debris-2026-01-01T00-00-00-000Z' },
          ],
        },
      },
      notices: {
        mcpOauthServersRequiringReauth: [],
        oauthLoginsRequiringRelogin: [],
        detectedPlugins: [],
        configConflictNotice: null,
        tuiConflictNotice: null,
        plansCopiedNotice: null,
      },
    };
    await writeReport(tgt, report);
    const text = await readFile(join(tgt, 'migration-report.json'), 'utf-8');
    const parsed = JSON.parse(text) as MigrationReport;
    expect(parsed.migratorVersion).toBe('0.1.1');
    // Per-item failures and archived debris survive the report round-trip —
    // the result screen / logs need them to point users at the recoverable copy.
    expect(parsed.summary.userHistory.failures).toEqual([
      { sourcePath: '/x/bad-history.jsonl', reason: 'EACCES' },
    ]);
    expect(parsed.summary.sessions.sessionsDebrisArchived).toEqual([
      { targetPath: '/t/ses_x', archivedPath: '/t/ses_x.debris-2026-01-01T00-00-00-000Z' },
    ]);
  });
});
