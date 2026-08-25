/**
 * Background-agent transcript card formatter: packs a background-agent
 * status snapshot (phase + metadata + optional result/error) into the
 * `BackgroundAgentStatusData` shape the transcript card renders.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */

import { t } from '#/i18n';
import type {
  BackgroundAgentMetadata,
  BackgroundAgentStatusData,
  BackgroundAgentStatusPhase,
} from '#/tui2/types';

const MAX_BACKGROUND_FIELD_LENGTH = 240;

function normalizeBackgroundField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.trim().replaceAll(/\s+/g, ' ');
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= MAX_BACKGROUND_FIELD_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_BACKGROUND_FIELD_LENGTH - 3)}...`;
}

export function formatBackgroundAgentTranscript(
  phase: BackgroundAgentStatusPhase,
  meta: BackgroundAgentMetadata,
  extras: { resultSummary?: string; error?: string } | undefined = undefined,
): BackgroundAgentStatusData {
  const normalizedAgentName = normalizeBackgroundField(meta.agentName);
  const subject = normalizedAgentName !== undefined ? `${normalizedAgentName} agent` : 'agent';
  const headline =
    phase === 'started'
      ? t('tui.messages.bgAgentStarted', { subject })
      : phase === 'completed'
        ? t('tui.messages.bgAgentCompleted', { subject })
        : phase === 'lost'
          ? t('tui.messages.bgAgentLost', { subject })
          : phase === 'killed'
            ? t('tui.messages.bgAgentKilled', { subject })
            : phase === 'timed_out'
              ? t('tui.messages.bgAgentTimedOut', { subject })
              : t('tui.messages.bgAgentFailed', { subject });
  const tail = phase === 'failed' ? normalizeBackgroundField(extras?.error) : undefined;
  const detailParts = [
    normalizeBackgroundField(meta.model),
    normalizeBackgroundField(meta.effort),
    normalizeBackgroundField(meta.description),
    tail,
  ].filter((part): part is string => part !== undefined);

  return {
    phase,
    headline,
    detail: detailParts.length > 0 ? detailParts.join(' · ') : undefined,
  };
}
