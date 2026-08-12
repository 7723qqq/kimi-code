import type { AgentRecord } from '../../types';
import { t } from '../../i18n';
import { Dim, type HeadlineRender } from './parts';
import { recordTypeOf, rendererFor } from './renderers';

export type { HeadlineRender };

/** Render the collapsed-headline for a wire record. Thin dispatch to the
 *  per-kind registry; unknown runtime kinds (best-effort parse of a
 *  future/legacy/foreign protocol, or a SQLite projection record without
 *  the legacy `type` discriminator) get a generic fallback so the row never
 *  crashes the tab. */
export function renderHeadline(r: AgentRecord): HeadlineRender {
  const type = recordTypeOf(r);
  const renderer = rendererFor(type);
  if (renderer !== undefined) return renderer.headline(r);
  return {
    main: <Dim>{t('wireRenderer.unknownRecordType', { type })}</Dim>,
  };
}
