import { expect, test } from 'bun:test';

import { say } from '@moonshot-ai/testkit/model';

import { withTerminal } from '../support/terminal-session';

test('[L0:tui.first-turn] submits the first prompt from the terminal and displays the answer', async () => {
  await withTerminal({}, async (terminal) => {
    const prompt = 'Hello terminal';
    const answer = 'Hello from the terminal.';
    terminal.model.script(say(answer));
    await terminal.type(prompt);
    await terminal.waitForText(prompt);
    terminal.press('Enter');
    await terminal.waitForText(answer);
    await terminal.waitForTurnToFinish();
    expect(terminal.model.requests('main').map((request) => request.firstUserText)).toEqual([prompt]);
  });
}, 90_000);
