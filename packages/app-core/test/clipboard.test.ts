import type { Mock } from 'bun:test';
import { stubGlobals } from '../../vite-preset/test/globals';
import { describe, expect, it, mock } from 'bun:test';
import { copyTextToClipboard } from '../src/lib/clipboard';

const stubGlobal = stubGlobals();

interface FakeDocument {
  execCommand: ReturnType<Mock>;
  createElement: ReturnType<Mock>;
  body: { appendChild: ReturnType<Mock>; removeChild: ReturnType<Mock> };
  textarea: { value: string; setAttribute: ReturnType<Mock>; focus: ReturnType<Mock>; select: ReturnType<Mock> };
}

function installDocument(execResult: boolean | Error): FakeDocument {
  const textarea = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: mock(),
    focus: mock(),
    select: mock(),
  };
  const doc: FakeDocument = {
    execCommand: mock().mockImplementation(() => {
      if (execResult instanceof Error) throw execResult;
      return execResult;
    }),
    createElement: mock().mockReturnValue(textarea),
    body: { appendChild: mock(), removeChild: mock() },
    textarea: textarea as FakeDocument['textarea'],
  };
  stubGlobal('document', doc);
  return doc;
}

function installBridge(writeClipboardText: unknown): void {
  stubGlobal('window', { kimiDesktop: { writeClipboardText } });
}

function installNavigator(clipboard: unknown): void {
  stubGlobal('navigator', clipboard === undefined ? {} : { clipboard });
}


describe('copyTextToClipboard', () => {
  it('uses navigator.clipboard when available', async () => {
    const writeText = mock().mockResolvedValue(undefined);
    installNavigator({ writeText });

    expect(await copyTextToClipboard('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when navigator.clipboard is undefined', async () => {
    installNavigator(undefined);
    const doc = installDocument(true);

    expect(await copyTextToClipboard('abc')).toBe(true);
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
    expect(doc.textarea.value).toBe('abc');
    expect(doc.body.appendChild).toHaveBeenCalledTimes(1);
    expect(doc.body.removeChild).toHaveBeenCalledTimes(1);
  });

  it('falls back to execCommand when writeText rejects', async () => {
    const writeText = mock().mockRejectedValue(new Error('denied'));
    installNavigator({ writeText });
    const doc = installDocument(true);

    expect(await copyTextToClipboard('retry')).toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
  });

  it('resolves false when both paths fail', async () => {
    installNavigator(undefined);
    installDocument(false);

    expect(await copyTextToClipboard('nope')).toBe(false);
  });

  it('prefers the desktop bridge over navigator.clipboard', async () => {
    const writeClipboardText = mock().mockResolvedValue(true);
    installBridge(writeClipboardText);
    const writeText = mock().mockResolvedValue(undefined);
    installNavigator({ writeText });

    expect(await copyTextToClipboard('session-1')).toBe(true);
    expect(writeClipboardText).toHaveBeenCalledWith('session-1');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to navigator.clipboard when the desktop bridge fails', async () => {
    installBridge(mock().mockRejectedValue(new Error('ipc')));
    const writeText = mock().mockResolvedValue(undefined);
    installNavigator({ writeText });

    expect(await copyTextToClipboard('fallback')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('fallback');
  });
});
