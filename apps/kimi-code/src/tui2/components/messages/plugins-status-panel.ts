/**
 * TUI2 plugins status report line builders for `/plugins list|info`.
 *
 * Mirrors `tui/components/messages/plugins-status-panel.ts` with the
 * ANSI colour layer removed: the tui2 transcript stores plain content
 * and opentui cannot render embedded ANSI. Trust badges, state markers
 * and the diagnostics structure are preserved as plain text; the future
 * transcript renderer applies colour tokens.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { PluginInfo, PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import {
  CURATED_BADGE,
  OFFICIAL_BADGE,
  THIRD_PARTY_BADGE,
  type PluginTrustLabel,
  formatPluginSourceLabel,
  pluginTrustLabel,
} from '../../utils/plugin-source-label';

export interface PluginsListPanelInput {
  readonly plugins: readonly PluginSummary[];
}

export function buildPluginsListLines(input: PluginsListPanelInput): readonly string[] {
  if (input.plugins.length === 0) {
    return [
      t('tui.messages.pluginsStatusPanel.noPlugins'),
      '',
      t('tui.messages.pluginsStatusPanel.installHint'),
    ];
  }
  const renderTrustBadge = (label: PluginTrustLabel): string => {
    if (label === 'official') return `[${OFFICIAL_BADGE}]`;
    if (label === 'curated') return `[${CURATED_BADGE}]`;
    return `[${THIRD_PARTY_BADGE}]`;
  };
  const lines: string[] = [];
  for (const plugin of input.plugins) {
    const enabled = plugin.enabled
      ? t('tui.messages.pluginsStatusPanel.enabled')
      : t('tui.messages.pluginsStatusPanel.disabled');
    const state = plugin.state === 'ok' ? '' : ` [${plugin.state}]`;
    const version = plugin.version ?? '-';
    const diagnostics = plugin.hasErrors ? t('tui.messages.pluginsStatusPanel.diagnosticsHint') : '';
    const sourceTag = `[${formatPluginSourceLabel(plugin)}]`;
    const trustBadge = ` ${renderTrustBadge(pluginTrustLabel(plugin))}`;
    lines.push(
      `${plugin.displayName} (${plugin.id}) ${version} ${sourceTag}${trustBadge} | ${enabled}${state}`,
    );
    const mcp =
      plugin.mcpServerCount > 0
        ? ` | ${t('tui.messages.pluginsStatusPanel.mcpCount', {
            enabled: plugin.enabledMcpServerCount,
            total: plugin.mcpServerCount,
          })}`
        : '';
    lines.push(
      `  ${t('tui.messages.pluginsStatusPanel.skillsLabel')} ${String(plugin.skillCount)}${mcp}${diagnostics}`,
    );
  }
  return lines;
}

export interface PluginsInfoPanelInput {
  readonly info: PluginInfo;
}

export function buildPluginsInfoLines(input: PluginsInfoPanelInput): readonly string[] {
  const { info } = input;
  const status = info.enabled
    ? t('tui.messages.pluginsStatusPanel.enabled')
    : t('tui.messages.pluginsStatusPanel.disabled');
  const trustLine = (() => {
    const label = pluginTrustLabel(info);
    if (label === 'official') {
      return `${t('tui.messages.pluginsStatusPanel.trust')}  ${OFFICIAL_BADGE} ${t('tui.messages.pluginsStatusPanel.officialDescription')}`;
    }
    if (label === 'curated') {
      return `${t('tui.messages.pluginsStatusPanel.trust')}  ${CURATED_BADGE} ${t('tui.messages.pluginsStatusPanel.curatedDescription')}`;
    }
    return `${t('tui.messages.pluginsStatusPanel.trust')}  ${THIRD_PARTY_BADGE}`;
  })();
  const lines: string[] = [
    `${info.displayName} (${info.id}) ${info.version ?? ''}`.trim(),
    `${t('tui.messages.pluginsStatusPanel.status')} ${status}${t('tui.messages.pluginsStatusPanel.statePrefix')}${stateText(info.state)}`,
    trustLine,
    `${t('tui.messages.pluginsStatusPanel.source')} ${info.source}`,
    `${t('tui.messages.pluginsStatusPanel.root')}   ${info.root}`,
  ];
  if (info.source === 'github' && info.github !== undefined) {
    const refLabel = `${info.github.ref.kind}:${info.github.ref.value}`;
    lines.push(
      `${t('tui.messages.pluginsStatusPanel.github')} ${`${info.github.owner}/${info.github.repo}`} @${refLabel}`,
    );
    if (info.github.installedSha !== undefined) {
      lines.push(
        `${t('tui.messages.pluginsStatusPanel.installedSha')} ${info.github.installedSha}`,
      );
    }
  }
  if (info.originalSource !== undefined) {
    lines.push(
      `${t('tui.messages.pluginsStatusPanel.originalSource')} ${info.originalSource}`,
    );
  }
  lines.push(`${t('tui.messages.pluginsStatusPanel.installedAt')} ${info.installedAt}`);
  if (info.updatedAt !== undefined && info.updatedAt !== info.installedAt) {
    lines.push(`${t('tui.messages.pluginsStatusPanel.lastUpdated')} ${info.updatedAt}`);
  }
  if (info.manifestPath !== undefined) {
    const kindSuffix =
      info.manifestKind !== undefined
        ? ` ${t('tui.messages.pluginsStatusPanel.manifestKind', { kind: info.manifestKind })}`
        : '';
    lines.push(`${t('tui.messages.pluginsStatusPanel.manifest')} ${info.manifestPath}${kindSuffix}`);
  }
  if (info.shadowedManifestPath !== undefined) {
    lines.push(
      `${t('tui.messages.pluginsStatusPanel.shadowed')} ${info.shadowedManifestPath}`,
    );
  }
  const sessionStartSkill = info.manifest?.sessionStart?.skill;
  if (sessionStartSkill !== undefined) {
    lines.push(`${t('tui.messages.pluginsStatusPanel.sessionStart')} ${sessionStartSkill}`);
  }
  if (info.manifest?.skillInstructions !== undefined) {
    lines.push(
      `${t('tui.messages.pluginsStatusPanel.skillInstructions')} ${t('tui.messages.pluginsStatusPanel.skillInstructionsPresent')}`,
    );
  }
  lines.push('');
  lines.push(
    t('tui.messages.pluginsStatusPanel.skills', {
      count: info.manifest?.skills?.length ?? 0,
    }),
  );
  for (const dir of info.manifest?.skills ?? []) lines.push(`  - ${dir}`);

  if (info.mcpServers.length > 0) {
    lines.push('');
    lines.push(
      t('tui.messages.pluginsStatusPanel.mcpServers', {
        enabled: info.enabledMcpServerCount,
        total: info.mcpServerCount,
      }),
    );
    lines.push(`  ${t('tui.messages.pluginsStatusPanel.mcpHint', { id: info.id })}`);
    for (const server of info.mcpServers) {
      const enabled = server.enabled
        ? t('tui.messages.pluginsStatusPanel.enabled')
        : t('tui.messages.pluginsStatusPanel.disabled');
      lines.push(`  - ${server.name} ${enabled} (${server.runtimeName})`);
      if (server.transport === 'stdio') {
        const args =
          server.args !== undefined && server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
        lines.push(
          `    ${t('tui.messages.pluginsStatusPanel.command')} ${`${server.command ?? ''}${args}`.trim()}`,
        );
        if (server.cwd !== undefined) {
          lines.push(`    ${t('tui.messages.pluginsStatusPanel.cwd')} ${server.cwd}`);
        }
        if (server.envKeys !== undefined && server.envKeys.length > 0) {
          lines.push(
            `    ${t('tui.messages.pluginsStatusPanel.env')} ${server.envKeys.join(', ')}`,
          );
        }
      } else {
        lines.push(`    ${t('tui.messages.pluginsStatusPanel.url')} ${server.url ?? ''}`);
        if (server.headerKeys !== undefined && server.headerKeys.length > 0) {
          lines.push(
            `    ${t('tui.messages.pluginsStatusPanel.headers')} ${server.headerKeys.join(', ')}`,
          );
        }
      }
    }
  }

  const iface = info.manifest?.interface;
  if (iface !== undefined) {
    lines.push('');
    lines.push(t('tui.messages.pluginsStatusPanel.display'));
    if (iface.shortDescription !== undefined) {
      lines.push(`  - ${iface.shortDescription}`);
    }
    if (iface.developerName !== undefined) {
      lines.push(`  - ${t('tui.messages.pluginsStatusPanel.by', { name: iface.developerName })}`);
    }
    if (iface.websiteURL !== undefined) lines.push(`  - ${iface.websiteURL}`);
  }

  if (info.manifest?.keywords !== undefined && info.manifest.keywords.length > 0) {
    lines.push('');
    lines.push(
      t('tui.messages.pluginsStatusPanel.keywords', {
        keywords: info.manifest.keywords.join(', '),
      }),
    );
  }

  if (info.diagnostics.length > 0) {
    lines.push('');
    lines.push(t('tui.messages.pluginsStatusPanel.diagnostics'));
    for (const d of info.diagnostics) {
      lines.push(`  [${d.severity}] ${d.message}`);
    }
  }
  return lines;
}

function stateText(state: PluginInfo['state']): string {
  return state;
}
