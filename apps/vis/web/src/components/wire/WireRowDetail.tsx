import { useState } from 'react';

import type { AgentRecord, WireEntry } from '../../types';
import { t } from '../../i18n';
import { CopyButton } from '../shared/CopyButton';
import { JsonViewer } from '../shared/JsonViewer';
import { GenericDetail } from './parts';
import { rendererFor } from './renderers';

interface WireRowDetailProps {
  entry: WireEntry;
  /** Scroll to + expand a given line. */
  onJumpTo?: (lineNo: number) => void;
}

type JsonView = 'none' | 'raw' | 'projected';

export function WireRowDetail({ entry }: WireRowDetailProps) {
  const [view, setView] = useState<JsonView>('none');
  // Only offer the dual view when migration actually changed something.
  // For records on the current protocol, `raw` and `data` are identical
  // and the toggle would just be visual noise.
  const migrated = !sameJson(entry.raw, entry.data);

  return (
    <div className="pl-[120px] pr-2 py-1 font-mono text-[12px]">
      {renderFriendly(entry.data)}
      <div className="mt-2 flex items-center justify-end gap-3">
        <CopyButton
          value={JSON.stringify(entry.raw, null, 2)}
          label={t('wireRowDetail.copyRaw')}
        />
        {migrated ? (
          <CopyButton
            value={JSON.stringify(entry.data, null, 2)}
            label={t('wireRowDetail.copyProjected')}
          />
        ) : null}
        <button
          onClick={() => {
            setView((v) => (v === 'raw' ? 'none' : 'raw'));
          }}
          className={`font-mono text-[10px] ${
            view === 'raw' ? 'text-fg-0' : 'text-fg-3 hover:text-fg-1'
          }`}
          title={t('wireRowDetail.rawTitle')}
        >
          {view === 'raw' ? t('wireRowDetail.hideRaw') : t('wireRowDetail.showRaw')}
        </button>
        {migrated ? (
          <button
            onClick={() => {
              setView((v) => (v === 'projected' ? 'none' : 'projected'));
            }}
            className={`font-mono text-[10px] ${
              view === 'projected' ? 'text-fg-0' : 'text-fg-3 hover:text-fg-1'
            }`}
            title={t('wireRowDetail.projectedTitle')}
          >
            {view === 'projected' ? t('wireRowDetail.hideProjected') : t('wireRowDetail.showProjected')}
          </button>
        ) : null}
      </div>
      {view !== 'none' ? (
        <div className="mt-2 border border-border bg-surface-0 p-2">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
            {view === 'raw' ? t('wireRowDetail.asWrittenOnDisk') : t('wireRowDetail.afterVisMigration')}
            {migrated && view === 'raw' ? (
              <span className="ml-2 text-[var(--color-sev-warning)]">
                {t('wireRowDetail.differsFromProjected')}
              </span>
            ) : null}
          </div>
          <JsonViewer
            value={view === 'raw' ? entry.raw : entry.data}
            defaultOpenDepth={2}
          />
        </div>
      ) : null}
    </div>
  );
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Render the expanded detail for a wire record. Thin dispatch to the per-kind
 *  registry's `detail`; kinds without one fall back to a structured JSON dump. */
function renderFriendly(record: AgentRecord) {
  const renderer = rendererFor(record.type);
  if (renderer?.detail !== undefined) return renderer.detail(record);
  return <GenericDetail value={record} />;
}
