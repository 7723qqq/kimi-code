/**
 * Scenario: the **observability** slice — `log` + `telemetry`.
 *
 * Builds a flat container that runs both services for real (neither has
 * cross-domain collaborators, so nothing is stubbed). `ILogService` writes
 * through the App console writer; `ITelemetryService` fans events out to a
 * console appender while merging bound context. The two compose: a child
 * logger and a context-scoped telemetry both carry their bound fields into
 * the output.
 */

import { afterEach, beforeEach, describe, test } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ILogService, ILogWriterService } from '#/log/log';
import { ConsoleLogWriterService, LogService } from '#/log/logService';
import { ConsoleAppender } from '#/telemetry/consoleAppender';
import { ITelemetryService } from '#/telemetry/telemetry';
import { TelemetryService } from '#/telemetry/telemetryService';

describe('observability slice (log + telemetry)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(ILogWriterService, ConsoleLogWriterService);
        reg.define(ILogService, LogService);
        reg.define(ITelemetryService, TelemetryService);
      },
    });
  });
  afterEach(() => {
    disposables.dispose();
  });

  test('emits structured logs and telemetry events with bound context', async () => {
    const log = ix.get(ILogService);
    log.setLevel('debug');
    log.debug('log: debug entry', { feature: 'observability' });
    log.info('log: info entry');
    log.child({ requestId: 'req-1' }).info('log: child entry with bound requestId');

    const telemetry = ix.get(ITelemetryService);
    telemetry.setAppender(new ConsoleAppender());
    telemetry.setContext({ app: 'example' });
    telemetry.track('session_started', { sessionId: 's1' });
    telemetry.withContext({ agentId: 'a1' }).track('turn_completed', { turns: 3 });
    await telemetry.shutdown();
  });
});
