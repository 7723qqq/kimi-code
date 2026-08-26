/** @jsxImportSource @opentui/solid */
/**
 * TUI2 migration screen — opentui + SolidJS first-launch migration flow.
 *
 * Replaces `migration/migration-screen.ts` (a pi-tui Container) with an
 * opentui flow run through the editor-replacement slot:
 *   ask1 (now / later / never)  →  ask2 (config-only / + sessions)  →  progress  →  result
 *
 * The ask phases reuse `<ChoicePicker>` (mounted twice, sequentially); the
 * progress and result phases are self-drawn dialogs. Decision mapping and
 * the real migration run stay in `@moonshot-ai/migration-legacy`
 * (`resolveMigrationScope` / `runMigration`).
 *
 * Status: REAL (tui2). No v1 counterpart to re-export.
 */

import type { Component } from 'solid-js';
import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { ColorInput } from '@opentui/core';

import {
  resolveMigrationScope,
  runMigration as realRunMigration,
  type MigrationPlan,
  type MigrationReport,
  type MigrationScope,
  type RunMigrationInput,
} from '@moonshot-ai/migration-legacy';

import { t } from '#/i18n';

import { ChoicePicker, type ChoiceOption } from '../components/dialogs/choice-picker';
import { currentTheme } from '../theme';
import { asReplacement, mountEditorReplacement, restoreEditor } from '../utils/editor-replacement';
import type { SlashCommandHost } from './dispatch';

import { Box } from '../components/common/box';
import { Text } from '../components/common/text';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const SPINNER_INTERVAL_MS = 80;

/** What the flow reports back to the caller when finished. */
export interface MigrationScreenResult {
  readonly decision: 'now' | 'later' | 'never';
  readonly scope?: MigrationScope;
  readonly migrated?: boolean;
}

interface MigrationFlowOptions {
  readonly host: SlashCommandHost;
  readonly plan: MigrationPlan;
  readonly sourceHome: string;
  readonly targetHome: string;
  /** Skip the now/later/never gate (explicit `kimi migrate` command). */
  readonly skipDecisionStep?: boolean;
  /** Injectable for tests; defaults to the package's runMigration. */
  readonly runMigration?: (input: RunMigrationInput) => Promise<MigrationReport>;
}

/** Mount a ChoicePicker in the editor slot and await its selection. */
function promptChoice(
  host: SlashCommandHost,
  title: string,
  hint: string,
  options: readonly ChoiceOption[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (host.store === undefined) {
      resolve(undefined);
      return;
    }
    mountEditorReplacement(
      host,
      asReplacement(ChoicePicker),
      {
        title,
        hint,
        options,
        onSelect: (value: string) => {
          restoreEditor(host);
          resolve(value);
        },
        onCancel: () => {
          restoreEditor(host);
          resolve(undefined);
        },
      },
    );
  });
}

/** Run the full migration flow; resolves with the final decision. */
export async function runMigrationFlow(
  options: MigrationFlowOptions,
): Promise<MigrationScreenResult> {
  const { host, plan, sourceHome, targetHome, skipDecisionStep } = options;

  const one = skipDecisionStep
    ? 'now'
    : await promptChoice(
        host,
        t('tui.migration.title'),
        t('tui.migration.navHintAsk', { action: t('tui.migration.askLater') }),
        [
          { label: t('tui.migration.migrateNow'), value: 'now' },
          { label: t('tui.migration.askLater'), value: 'later' },
          { label: t('tui.migration.neverAgain'), value: 'never' },
        ],
      );
  if (one === undefined) return { decision: 'later' };
  if (one === 'later') return { decision: 'later' };
  if (one === 'never') return { decision: 'never' };

  const sessionsLabel =
    plan.totalSessions > 0
      ? t('tui.migration.configPlusSessions', { count: String(plan.totalSessions) })
      : t('tui.migration.configPlusAllSessions');
  const two = await promptChoice(
    host,
    t('tui.migration.ask2Title'),
    t('tui.migration.navHintAsk', { action: t('tui.migration.askLater') }),
    [
      { label: t('tui.migration.configOnly'), value: 'config-only' },
      { label: sessionsLabel, value: 'all-sessions' },
    ],
  );
  if (two === undefined) return { decision: 'later' };

  const resolved = resolveMigrationScope([
    'now' as const,
    two as Parameters<typeof resolveMigrationScope>[0][number],
  ]);
  if (resolved.decision !== 'now' || resolved.scope === undefined) {
    return { decision: 'later' };
  }
  const scope = resolved.scope;

  const migrated = await runWithProgress(host, options.runMigration ?? realRunMigration, {
    plan,
    scope,
    source: sourceHome,
    target: targetHome,
  });
  return { decision: 'now', scope, migrated };
}

// ---------------------------------------------------------------------------
// Progress + result dialogs
// ---------------------------------------------------------------------------

interface FlowState {
  stepStatus: Record<string, 'pending' | 'done'>;
  done: number;
  total: number;
  failed: boolean;
  failureReason?: string;
  report?: MigrationReport;
}

function stepLabels(): ReadonlyArray<readonly [string, string]> {
  return [
    ['config', t('tui.migration.stepLabelConfig')],
    ['mcp', t('tui.migration.stepLabelMcp')],
    ['user-history', t('tui.migration.stepLabelReplHistory')],
    ['sessions', t('tui.migration.stepLabelSessions')],
  ];
}

function baseStatus(): FlowState {
  return {
    stepStatus: {
      config: 'pending',
      mcp: 'pending',
      'user-history': 'pending',
      sessions: 'pending',
    },
    done: 0,
    total: 0,
    failed: false,
  };
}

/** Run migration behind a spinner dialog; resolves once it settles. */
function runWithProgress(
  host: SlashCommandHost,
  runMigration: (input: RunMigrationInput) => Promise<MigrationReport>,
  input: RunMigrationInput,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (host.store === undefined) {
      resolve(false);
      return;
    }
    const update = (): FlowState => {
      const s = storeSnapshot();
      host.store?.setState(
        // Re-mount with the latest snapshot so the dialog re-renders.
        'editorReplacement',
        { component: asReplacement(MigrationProgressDialog), props: { state: s } },
      );
      return s;
    };
    const storeSnapshot = (): FlowState => latest;
    let latest: FlowState = baseStatus();

    runMigration({
      ...input,
      onProgress: (msg) => {
        const key = msg.replace(/ done$/, '');
        if (key in latest.stepStatus) latest.stepStatus[key] = 'done';
        update();
      },
      onSessionProgress: (done, total) => {
        latest.done = done;
        latest.total = total;
        update();
      },
    }).then(
      (report) => {
        latest.report = report;
        latest.failed = false;
        update();
        void promptResult(host, latest).then((r) => resolve(r));
      },
      (error) => {
        latest.failed = true;
        latest.failureReason = formatMigrationFailureReason(error);
        update();
        void promptResult(host, latest).then((r) => resolve(r));
      },
    );
  });
}

/** Result phase: show the report; Enter (or any key) finishes the flow. */
function promptResult(host: SlashCommandHost, state: FlowState): Promise<boolean> {
  return new Promise((resolve) => {
    mountEditorReplacement(
      host,
      asReplacement(MigrationResultDialog),
      {
        state,
        onDone: () => {
          restoreEditor(host);
          resolve(!state.failed);
        },
      },
    );
  });
}

const MigrationProgressDialog: Component<{ state: FlowState }> = (props) => {
  const [frame, setFrame] = createSignal(0);
  const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS);
  onCleanup(() => clearInterval(timer));

  const spinner = (): string => SPINNER_FRAMES[frame()] ?? SPINNER_FRAMES[0];
  const borderFg = (): ColorInput => currentTheme.color('primary');
  const textFg = (): ColorInput => currentTheme.color('text');
  const dimFg = (): ColorInput => currentTheme.color('textDim');
  const successFg = (): ColorInput => currentTheme.color('success');
  const accentFg = (): ColorInput => currentTheme.color('accent');

  return (
    <Box flexDirection="column">
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      <Box>
        <Text fg={borderFg()} attributes={currentTheme.attributes('bold')}>
          {t('tui.migration.progressTitle')}
        </Text>
      </Box>
      <Box>
        <Text>{''}</Text>
      </Box>
      <Show when={props.state.total > 0}>
        <Box flexDirection="row">
          <Text fg={accentFg()}>{`  ${spinner()}  `}</Text>
          <Text fg={textFg()}>
            {t('tui.migration.progressTranslating', {
              done: String(props.state.done),
              total: String(props.state.total),
            })}
          </Text>
        </Box>
        <Box>
          <Text>{''}</Text>
        </Box>
      </Show>
      <For each={stepLabels()}>
        {([key, label]) => {
          const done = (): boolean => props.state.stepStatus[key] === 'done';
          return (
            <Box flexDirection="row">
              <Text fg={done() ? successFg() : dimFg()}>{done() ? '  ✓ ' : '  ◐ '}</Text>
              <Text fg={textFg()}>{label}</Text>
            </Box>
          );
        }}
      </For>
      <Box>
        <Text>{''}</Text>
      </Box>
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  );
};

const MigrationResultDialog: Component<{
  state: FlowState;
  onDone: () => void;
}> = (props) => {
  const borderFg = (): ColorInput => currentTheme.color('primary');
  const textFg = (): ColorInput => currentTheme.color('text');
  const dimFg = (): ColorInput => currentTheme.color('textMuted');
  const successFg = (): ColorInput => currentTheme.color('success');
  const warningFg = (): ColorInput => currentTheme.color('warning');
  const errorFg = (): ColorInput => currentTheme.color('error');

  const report = (): MigrationReport | undefined => props.state.report;

  const migratedKinds = (): readonly string[] => {
    const r = report();
    if (r === undefined) return [];
    const sum = r.summary;
    const kinds: string[] = [];
    if (sum.config.migrated) kinds.push('config');
    if (sum.config.migratedHooks > 0) kinds.push('hooks');
    if (sum.mcp.mergedServers.length > 0) kinds.push('MCP');
    if (sum.userHistory.copied > 0) kinds.push(t('tui.migration.stepLabelReplHistory'));
    if (sum.skills.copied > 0) kinds.push('skills');
    return kinds;
  };

  const lines = (): readonly (readonly [ColorInput, string])[] => {
    const out: (readonly [ColorInput, string])[] = [];
    if (props.state.failed) {
      out.push([errorFg(), t('tui.migration.failed')]);
      if (props.state.failureReason !== undefined) {
        out.push([textFg(), t('tui.migration.reason', { reason: props.state.failureReason })]);
      }
      out.push([textFg(), t('tui.migration.retryHint')]);
      return out;
    }
    const r = report();
    out.push([successFg(), t('tui.migration.complete')]);
    if (r !== undefined) {
      const sum = r.summary;
      if (sum.sessions.sessionsMigrated > 0) {
        out.push([
          successFg(),
          t('tui.migration.sessionsMigrated', { count: String(sum.sessions.sessionsMigrated) }),
        ]);
      }
      const kinds = migratedKinds();
      if (kinds.length > 0) {
        out.push([successFg(), t('tui.migration.kindsMigrated', { kinds: kinds.join(' · ') })]);
      }
      if (sum.sessions.sessionsMigrated === 0 && kinds.length === 0) {
        out.push([dimFg(), t('tui.migration.skipped')]);
      }
      if (r.notices.detectedPlugins.length > 0) {
        out.push([
          warningFg(),
          t('tui.migration.pluginsNotSupported', {
            count: String(r.notices.detectedPlugins.length),
          }),
        ]);
      }
      if (sum.sessions.sessionsFailed.length > 0) {
        out.push([
          warningFg(),
          t('tui.migration.sessionsFailed', {
            count: String(sum.sessions.sessionsFailed.length),
          }),
        ]);
      }
    }
    out.push([dimFg(), t('tui.migration.oldDataKept')]);
    return out;
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      <For each={lines()}>
        {([fg, text]) => (
          <Box>
            <Text fg={fg}>{` ${text}`}</Text>
          </Box>
        )}
      </For>
      <Box>
        <Text>{''}</Text>
      </Box>
      <Box>
        <Text fg={dimFg()}>{t('tui.migration.continueHint')}</Text>
      </Box>
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  );
};

function formatMigrationFailureReason(error: unknown): string | undefined {
  let reason: string | undefined;
  if (error instanceof Error) {
    reason = error.message !== '' ? error.message : error.name;
  } else if (typeof error === 'string') {
    reason = error;
  } else if (typeof error === 'object' && error !== null) {
    const maybeMessage = (error as { readonly message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage !== '') reason = maybeMessage;
  }
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}