import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';
import {
  runMigration,
  type MigrationPlan,
  type MigrationReport,
  type MigrationScope,
} from '@moonshot-ai/migration-legacy';

import { t } from '#/i18n';

import { detectPendingMigration } from './detect-pending';
import { resolveLegacySourceHome, sameLegacyPath } from './legacy-source';

export const MIGRATE_HEADLESS_EXIT = {
  success: 0,
  incomplete: 1,
  error: 2,
} as const;

export interface HeadlessMigrateDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly userHome: string;
  readonly cwd: string;
  readonly targetHome: string;
  readonly write: (line: string) => void;
}

export interface HeadlessMigrateInput {
  readonly configOnly: boolean;
}

function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export async function runHeadlessMigrate(
  input: HeadlessMigrateInput,
  deps?: Partial<HeadlessMigrateDeps>,
): Promise<number> {
  const resolved: HeadlessMigrateDeps = {
    env: deps?.env ?? process.env,
    userHome: deps?.userHome ?? homedir(),
    cwd: deps?.cwd ?? process.cwd(),
    targetHome: deps?.targetHome ?? resolveKimiHome(),
    write: deps?.write ?? defaultWrite,
  };
  const log = (msg: string): void => {
    resolved.write(`[kimi-migrate ${timestamp()}] ${msg}`);
  };

  const source = resolveLegacySourceHome(resolved.env, resolved.userHome, resolved.cwd);
  log(
    t('tui.migration.headlessSource', {
      path: source.sourceHome,
      origin: source.origin === 'share-dir' ? 'KIMI_SHARE_DIR' : 'default ~/.kimi',
    }),
  );
  if (source.skillsSourceHome !== undefined) {
    log(t('tui.migration.headlessSkillsSource', { path: source.skillsSourceHome }));
  }
  log(t('tui.migration.headlessTarget', { path: resolved.targetHome }));

  if (sameLegacyPath(source.sourceHome, resolved.targetHome)) {
    log(t('tui.migration.headlessSameSourceTarget'));
    return MIGRATE_HEADLESS_EXIT.error;
  }

  const scope: MigrationScope = {
    config: true,
    mcp: true,
    userHistory: true,
    skills: true,
    sessions: !input.configOnly,
  };
  log(
    t(
      input.configOnly
        ? 'tui.migration.headlessScopeConfigOnly'
        : 'tui.migration.headlessScopeFull',
    ),
  );

  log(t('tui.migration.headlessDetecting'));
  const plansSourceHome = join(resolved.userHome, '.kimi', 'plans');
  const plan = await detectPendingMigration({
    sourceHome: source.sourceHome,
    skillsSourceHome: source.skillsSourceHome,
    targetHome: resolved.targetHome,
    plansSourceHome,
    ignoreMarker: true,
  });
  if (plan === null) {
    log(t('tui.migration.headlessNothingToMigrate', { path: source.sourceHome }));
    return MIGRATE_HEADLESS_EXIT.success;
  }
  logPlan(plan, log);

  let report: MigrationReport;
  try {
    report = await runMigration({
      plan,
      scope,
      source: source.sourceHome,
      target: resolved.targetHome,
      plansSourceDir: plansSourceHome,
      onProgress: (msg) => log(t('tui.migration.headlessStep', { message: msg })),
      onSessionProgress: (done, total) =>
        log(
          t('tui.migration.headlessSessionsTranslating', {
            done: String(done),
            total: String(total),
          }),
        ),
    });
  } catch (error) {
    log(
      t('tui.migration.headlessCrashed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return MIGRATE_HEADLESS_EXIT.error;
  }

  const complete = logReport(report, scope, log);
  log(
    t('tui.migration.headlessReportWritten', {
      path: `${resolved.targetHome}/migration-report.json`,
    }),
  );
  log(t('tui.migration.headlessRunLog', { path: `${resolved.targetHome}/migration-errors.log` }));
  if (complete) {
    log(t('tui.migration.headlessResultComplete'));
    return MIGRATE_HEADLESS_EXIT.success;
  }
  log(t('tui.migration.headlessResultIncomplete'));
  return MIGRATE_HEADLESS_EXIT.incomplete;
}

function logPlan(plan: MigrationPlan, log: (msg: string) => void): void {
  const scanFailures = plan.sessionScanFailures?.length ?? 0;
  log(
    t('tui.migration.headlessDetected', {
      sessions: String(plan.totalSessions),
      workdirs: String(plan.workdirs.length),
      config: String(plan.hasConfig),
      mcp: String(plan.hasMcp),
      userHistory: String(plan.hasUserHistory),
      skills: String(plan.hasSkills),
    }) +
      (scanFailures > 0
        ? t('tui.migration.headlessDetectedUnreadable', { count: String(scanFailures) })
        : ''),
  );
  for (const failure of plan.sessionScanFailures ?? []) {
    log(
      t('tui.migration.headlessUnreadableStore', {
        path: failure.sourcePath,
        reason: failure.reason,
      }),
    );
  }
  if (plan.oauthCredentials.length > 0) {
    log(t('tui.migration.headlessRelogin', { names: plan.oauthCredentials.join(', ') }));
  }
  if (plan.detectedMcpOauthServers.length > 0) {
    log(t('tui.migration.headlessMcpReauth', { names: plan.detectedMcpOauthServers.join(', ') }));
  }
  if (plan.detectedPlugins.length > 0) {
    log(t('tui.migration.headlessPluginsNotMigrated', { names: plan.detectedPlugins.join(', ') }));
  }
}

function logReport(
  report: MigrationReport,
  scope: MigrationScope,
  log: (msg: string) => void,
): boolean {
  const sum = report.summary;
  const c = sum.config;
  log(
    `config: migrated=${c.migrated} tui-extracted=${c.tuiExtracted}` +
      ` hooks-migrated=${c.migratedHooks} hooks-dropped=${c.droppedHooks}` +
      (c.droppedProviders.length > 0
        ? ` dropped-providers=[${c.droppedProviders.join(', ')}]`
        : '') +
      (c.droppedModels.length > 0 ? ` dropped-models=[${c.droppedModels.join(', ')}]` : '') +
      (c.droppedKeys.length > 0 ? ` dropped-keys=[${c.droppedKeys.join(', ')}]` : '') +
      (c.configConflicts.length > 0
        ? ` conflicts-kept-yours=[${c.configConflicts.join(', ')}]`
        : '') +
      (c.sourceUnreadable ? ' SOURCE-UNREADABLE' : ''),
  );
  if (c.wroteSiblingDueToConflict) {
    log(
      t('tui.migration.headlessConfigSibling', {
        providers: String(c.siblingContents.providers.length),
        models: String(c.siblingContents.models.length),
        hooks: String(c.siblingContents.hooks),
      }),
    );
  }
  if (c.wroteTuiSibling) {
    log(t('tui.migration.headlessTuiSibling'));
  }
  const m = sum.mcp;
  log(
    `mcp: merged=[${m.mergedServers.join(', ')}]` +
      (m.keptNewForConflicts.length > 0
        ? ` kept-existing=[${m.keptNewForConflicts.join(', ')}]`
        : '') +
      (m.droppedServers.length > 0 ? ` dropped=[${m.droppedServers.join(', ')}]` : '') +
      (m.wroteSiblingDueToConflict ? ' wrote mcp.migrated-from-kimi-cli.json' : '') +
      (m.sourceUnreadable ? ' SOURCE-UNREADABLE' : ''),
  );
  log(
    `user-history: copied=${sum.userHistory.copied} skipped-existing=${sum.userHistory.skippedExisting}`,
  );
  log(`skills: copied=${sum.skills.copied} skipped-existing=${sum.skills.skippedExisting}`);
  log(`plans: copied=${sum.plans.copied} skipped-existing=${sum.plans.skippedExisting}`);
  const s = sum.sessions;
  if (scope.sessions) {
    log(
      `sessions: scanned=${s.bucketsScanned} attempted=${s.sessionsAttempted} migrated=${s.sessionsMigrated}` +
        ` already-migrated=${s.sessionsAlreadyMigrated} skipped-empty=${s.sessionsSkippedEmpty}` +
        ` skipped-placeholder=${s.sessionsSkippedPlaceholder}` +
        ` failed=${s.sessionsFailed.length} conflicts=${s.sessionsConflicts.length}` +
        (s.bucketsSkippedNonlocalKaos > 0
          ? ` buckets-skipped-nonlocal-kaos=${s.bucketsSkippedNonlocalKaos}`
          : '') +
        (s.bucketsSkippedNoWorkdirFound > 0
          ? ` buckets-skipped-no-workdir=${s.bucketsSkippedNoWorkdirFound}`
          : ''),
    );
    for (const failure of s.sessionsFailed) {
      log(
        t('tui.migration.headlessFailedSession', {
          path: failure.sourcePath,
          reason: failure.reason,
        }),
      );
    }
    for (const conflict of s.sessionsConflicts) {
      log(
        t('tui.migration.headlessConflictSession', {
          path: conflict.sourcePath,
          target: conflict.targetPath,
        }),
      );
    }
  }
  if (report.notices.oauthLoginsRequiringRelogin.length > 0) {
    log(
      t('tui.migration.headlessRelogin', {
        names: report.notices.oauthLoginsRequiringRelogin.join(', '),
      }),
    );
  }
  if (report.notices.mcpOauthServersRequiringReauth.length > 0) {
    log(
      t('tui.migration.headlessMcpReauth', {
        names: report.notices.mcpOauthServersRequiringReauth.join(', '),
      }),
    );
  }
  if (report.notices.configConflictSibling !== null) {
    log(t('tui.migration.headlessConfigConflict', { path: report.notices.configConflictSibling }));
  }
  if (report.notices.tuiConflictSibling !== null) {
    log(t('tui.migration.headlessTuiConflict', { path: report.notices.tuiConflictSibling }));
  }
  const plansCopied = report.notices.plansCopied;
  if (plansCopied !== null) {
    log(
      t(
        plansCopied.count === 1
          ? 'tui.migration.headlessPlansCopied_one'
          : 'tui.migration.headlessPlansCopied_other',
        { count: String(plansCopied.count), path: plansCopied.directory },
      ),
    );
  }
  return (
    s.sessionsFailed.length === 0 &&
    s.sessionsConflicts.length === 0 &&
    !(scope.config && c.sourceUnreadable) &&
    !(scope.mcp && m.sourceUnreadable)
  );
}
