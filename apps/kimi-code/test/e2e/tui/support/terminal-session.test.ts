import { expect, test } from 'bun:test';

import { say } from '@moonshot-ai/testkit/model';

import { withTerminal } from './terminal-session';

test('distinguishes pasted drafts from submitted text and explains a missing screen state', async () => {
  await withTerminal({}, async (terminal) => {
    const draft = 'An unsent pasted draft';
    await terminal.paste(draft);
    await terminal.waitForText(draft);
    terminal.press('Ctrl+C');
    await terminal.waitForTextGone(draft);
    expect(terminal.model.requests('main')).toHaveLength(0);

    const lines = Array.from({ length: 48 }, (_, i) => `Output line ${i + 1}.`);
    terminal.model.script(say([...lines, 'Diagnostic reply.'].join('\n\n')));
    await terminal.paste('Send this question');
    terminal.press('Enter');
    await terminal.waitForText('Diagnostic reply.');
    await terminal.waitForTurnToFinish();
    expect(await terminal.viewport()).not.toContain(lines[0]!);
    expect(await terminal.scrollback()).toContain(lines[0]!);
    const missing = terminal.waitForText('Missing screen marker', 100);
    await expect(missing).rejects.toThrow(
      /Missing screen marker.*recent input=.*Send this question.*Screen:.*Diagnostic reply\..*Stderr:.*Model requests:.*"lane":"main"/s,
    );
  });
}, 90_000);

test('edits the draft with keys in a small terminal and sends what is on screen', async () => {
  await withTerminal({ columns: 60, rows: 12 }, async (terminal) => {
    await terminal.type('Hellp');
    terminal.press('Backspace');
    await terminal.type('o');
    await terminal.waitForText('Hello');
    terminal.model.script(say('Hi there.'));
    terminal.press('Enter');
    await terminal.waitForText('Hi there.');
    await terminal.waitForTurnToFinish();
    expect(terminal.model.requests('main').map((request) => request.firstUserText)).toEqual(['Hello']);
  });
}, 90_000);
