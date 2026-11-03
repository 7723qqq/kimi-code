import { ProcessTerminal, TuiMainScreen } from '@moonshot-ai/pi-tui';

import { createTelemetryHarness } from '#/cli/harness';
import { t } from '#/i18n';

import { importBudget, importSessions, scanImportableSessions, sourceHomes } from './run-import';
import { ImportSessionsScreenComponent } from './screen';

/** `kimi import-sessions`: show only the import page in a bare terminal UI, then exit. */
export async function runImportSessionsCommand(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`${t('tui.messages.importSessions.needsTty')}\n`);
    return 1;
  }
  const { harness } = createTelemetryHarness();
  try {
    const kimiHome = harness.homeDir;
    const budget = importBudget(await harness.getConfig().catch(() => ({})));
    const now = Date.now();
    const homes = sourceHomes();
    const ui = new TuiMainScreen(new ProcessTerminal());
    await new Promise<void>((resolve) => {
      const screen = new ImportSessionsScreenComponent({
        now,
        scan: () => scanImportableSessions({ kimiHome, ...homes, now }),
        run: (candidates, hooks) =>
          importSessions(candidates, { kimiHome, ...budget, now, ...hooks }),
        requestRender: () => {
          ui.requestRender();
        },
        onClose: () => {
          resolve();
        },
      });
      ui.addChild(screen);
      ui.setFocus(screen);
      ui.start();
    });
    ui.stop();
    return 0;
  } finally {
    await harness.close();
  }
}
