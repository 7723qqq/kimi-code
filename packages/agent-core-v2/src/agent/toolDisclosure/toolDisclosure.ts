import { collection } from '#/_base/di/collection';
import type { ServicesAccessor } from '#/_base/di/instantiation';

export interface ToolDisclosureContribution {
  readonly name: string;
  readonly visible: (accessor: ServicesAccessor) => boolean;
}

export const ToolDisclosureContribution = collection<ToolDisclosureContribution>(
  'tool-disclosure',
);