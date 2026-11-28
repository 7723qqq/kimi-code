import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UNDO_LIMIT_STATUS_TURN_ID } from '#/tui/constant/kimi-tui';
import {
  hasResumableTranscriptContent,
  ProgramResumeController,
  type ProgramResumeState,
} from '#/tui/controllers/program-resume';

function decodeOsc7577(seq: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const body = seq.slice('\x1b]7577;'.length, -'\x1b\\'.length);
  for (const part of body.split(':')) {
    const eq = part.indexOf('=');
    fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return fields;
}

describe('hasResumableTranscriptContent', () => {
  it('ignores undo limit status entries', () => {
    expect(hasResumableTranscriptContent([])).toBe(false);
    expect(
      hasResumableTranscriptContent([{ kind: 'status', turnId: UNDO_LIMIT_STATUS_TURN_ID }]),
    ).toBe(false);
    expect(hasResumableTranscriptContent([{ kind: 'user', turnId: 't1' }])).toBe(true);
  });
});

describe('ProgramResumeController', () => {
  const workDir = join(tmpdir(), 'kimi-program-resume-project');

  function makeState(overrides?: Partial<ProgramResumeState['appState']>): {
    state: ProgramResumeState & {
      appState: { isReplaying: boolean; sessionId: string; workDir: string };
      transcriptEntries: Array<{ kind?: string; turnId?: string }>;
    };
    writes: string[];
  } {
    const state = {
      appState: {
        isReplaying: false,
        sessionId: 'ses-abc',
        workDir,
        ...overrides,
      },
      transcriptEntries: [{ kind: 'user', turnId: 't1' }] as Array<{
        kind?: string;
        turnId?: string;
      }>,
    };
    const writes: string[] = [];
    return { state, writes };
  }

  it('does nothing when disabled without a token', () => {
    const { state, writes } = makeState();
    const controller = new ProgramResumeController(state, { write: (s) => writes.push(s) });
    controller.refresh();
    controller.clearForExit();
    expect(writes).toEqual([]);
  });

  it('emits OSC 7577 when session and content are ready, then clears on empty or exit', () => {
    const { state, writes } = makeState();
    const controller = new ProgramResumeController(
      state,
      { write: (s) => writes.push(s) },
      {
        token: 'tok-1',
        commandName: 'kimi',
        pid: 123,
        nowSeconds: () => 1_700_000_010,
      },
    );

    if (process.platform === 'win32') {
      // On Windows, a bare command name is looked up on PATH; pass an explicit trusted command path for platform-independent assertion.
      const winController = new ProgramResumeController(
        state,
        { write: (s) => writes.push(s) },
        {
          token: 'tok-1',
          commandName: process.execPath,
          pid: 123,
          nowSeconds: () => 1_700_000_010,
        },
      );
      winController.refresh();
      expect(writes).toHaveLength(1);
      const fields = decodeOsc7577(writes[0]!);
      const argv = fields['argv']!
        .split(',')
        .map((p) => Buffer.from(p, 'base64').toString('utf8'));
      expect(argv).toEqual([process.execPath, '-r', 'ses-abc']);
      const payloadWithoutMac = writes[0]!.slice('\x1b]7577;'.length, writes[0]!.lastIndexOf(':mac='));
      expect(fields['mac']).toBe(
        createHash('sha256').update(`${payloadWithoutMac}:tok-1`).digest('hex'),
      );
      winController.clearForExit();
      expect(decodeOsc7577(writes[1]!)['clear']).toBe('1');
      return;
    }

    controller.refresh();
    expect(writes).toHaveLength(1);
    const fields = decodeOsc7577(writes[0]!);
    expect(fields['argv']!.split(',').map((p) => Buffer.from(p, 'base64').toString('utf8'))).toEqual([
      'kimi',
      '-r',
      'ses-abc',
    ]);
    state.transcriptEntries.length = 0;
    controller.refresh();
    expect(decodeOsc7577(writes[1]!)['clear']).toBe('1');
  });

  it('defers writes while held and respects preserveForSignal unless forced', () => {
    const { state, writes } = makeState();
    const controller = new ProgramResumeController(
      state,
      { write: (s) => writes.push(s) },
      {
        token: 'tok-2',
        commandName: process.platform === 'win32' ? process.execPath : 'kimi',
        pid: 456,
        nowSeconds: () => 1_700_000_020,
      },
    );

    const release = controller.hold();
    controller.refresh();
    expect(writes).toEqual([]);
    release();
    expect(writes).toHaveLength(1);

    controller.preserveForSignal();
    controller.clearForExit();
    expect(writes).toHaveLength(1);
    controller.clearForExit({ force: true });
    expect(writes).toHaveLength(2);
    expect(decodeOsc7577(writes[1]!)['clear']).toBe('1');
  });
});
