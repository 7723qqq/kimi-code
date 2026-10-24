import type { KimiRegion } from '@moonshot-ai/kimi-code-oauth';

import type { FetchLike } from '#/_base/utils/fetchLike';
import type { IPluginService } from '#/app/plugin/plugin';
import type { IHostProcessService } from '#/os/interface/hostProcess';

export interface CapabilityEntryContext {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly kimiHomeDir: string;
  readonly userHomeDir: string;
  readonly plugins: IPluginService;
  readonly hostProcess: IHostProcessService;
  readonly fetchImpl?: FetchLike;
  readonly applicationsDir?: string;
  readonly webbridgeBaseUrl?: string;
  readonly detectProbeTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly resolveRegion?: () => KimiRegion | Promise<KimiRegion>;
}
