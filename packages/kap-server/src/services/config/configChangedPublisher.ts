import {
  ConfigChanged,
  IConfigService,
  IEventService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { SYSTEM_CLOCK, type Clock, type TimerHandle } from '../../lib/clock';
import { toConfigResponse } from '../../routes/config';

export interface ConfigChangedPublisher {
  close(): void;
}

const FLUSH_DELAY_MS = 10;

export function startConfigChangedPublisher(
  core: Scope,
  clock: Clock = SYSTEM_CLOCK,
): ConfigChangedPublisher {
  const config = core.accessor.get(IConfigService);
  const events = core.accessor.get(IEventService);
  let closed = false;
  let timer: TimerHandle | undefined;
  const pending = new Set<string>();

  const flush = (): void => {
    timer = undefined;
    if (closed || pending.size === 0) return;
    const changedFields = [...pending].toSorted();
    pending.clear();
    events.publish(
      new ConfigChanged({
        payload: { changedFields, config: toConfigResponse(config.getAll()) },
      }),
    );
  };

  const subscription = config.onDidSectionChange((event) => {
    if (closed) return;
    pending.add(event.domain);
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = clock.setTimeout(flush, FLUSH_DELAY_MS);
  });

  return {
    close: () => {
      closed = true;
      if (timer !== undefined) {
        clock.clearTimeout(timer);
        timer = undefined;
      }
      pending.clear();
      subscription.dispose();
    },
  };
}
