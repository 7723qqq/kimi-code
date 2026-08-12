import { Pill } from '../shared/Pill';
import { rendererFor } from './renderers';

interface TypeBadgeProps {
  /** Runtime discriminator — a known `RecordType` or an unknown/foreign
   *  string (including `record_type` values from SQLite projections). */
  type: string;
}

export function TypeBadge({ type }: TypeBadgeProps) {
  const renderer = rendererFor(type);
  const label = renderer?.label ?? type;
  const tone = renderer?.tone ?? 'neutral';
  return (
    <Pill tone={tone} variant="soft" title={type}>
      {label}
    </Pill>
  );
}
