import { describe, expect, it } from 'bun:test';

import {
  READ_OUTPUT_HINT,
  formatOutputSize,
  outputNextStep,
  outputSizeLine,
  outputUnitWord,
  renderAppendedPointer,
  renderReplacedPointer,
  renderUnpersistedPointer,
} from '../../src/tool/outputPointer';

describe('outputPointer fragments', () => {
  it('spells chars out and leaves bytes alone', () => {
    expect(outputUnitWord('chars')).toBe('characters');
    expect(outputUnitWord('bytes')).toBe('bytes');
  });

  it('formats a size field by unit', () => {
    expect(formatOutputSize('chars', 50100)).toBe('output_size_chars: 50100');
    expect(formatOutputSize('bytes', 204800)).toBe('output_size_bytes: 204800');
  });

  it('renders a bare size when nothing was dropped', () => {
    expect(outputSizeLine('chars', 50100)).toBe('output_size_chars: 50100');
    expect(outputSizeLine('chars', 120, 120)).toBe('output_size_chars: 120');
  });

  it('adds the preservation note with the unit word', () => {
    expect(outputSizeLine('chars', 25_000_000, 60_000)).toBe(
      'output_size_chars: 25000000 (only the first 60000 characters were preserved)',
    );
    expect(outputSizeLine('bytes', 100, 40)).toBe(
      'output_size_bytes: 100 (only the first 40 bytes were preserved)',
    );
  });

  it('names Read with output_path for a spilled pointer', () => {
    expect(outputNextStep('read')).toBe(READ_OUTPUT_HINT);
  });

  it('names the task id for a background task', () => {
    expect(outputNextStep('task-output', 'task-1')).toBe(
      'next_step: Use TaskOutput(task_id="task-1") to query the task output.',
    );
    expect(outputNextStep('task-output')).toBe(
      'next_step: Use TaskOutput with the task_id to query the task output.',
    );
  });
});

describe('appended pointer', () => {
  it('renders three lines with no size field', () => {
    expect(
      renderAppendedPointer({ path: '/tmp/a.log', totalSize: 90000, unit: 'chars', preserved: 90000 }),
    ).toBe(
      [
        '[Per-line truncation occurred; the complete output was saved to a file.',
        'output_path: /tmp/a.log',
        `${READ_OUTPUT_HINT}]`,
      ].join('\n'),
    );
  });

  it('renders the partial headline when only a prefix was kept', () => {
    expect(
      renderAppendedPointer({ path: '/tmp/a.log', totalSize: 90000, unit: 'chars', preserved: 4096 }),
    ).toContain(
      '[Per-line truncation occurred; only the first 4096 characters (of 90000) were saved to a file.',
    );
  });

  it('renders the media headline', () => {
    expect(
      renderAppendedPointer({
        path: '/tmp/a.log',
        totalSize: 90000,
        unit: 'chars',
        preserved: 90000,
        hasMedia: true,
      }),
    ).toContain(
      '[Per-line truncation occurred; the complete text output was saved to a file (media parts stay attached to this result).',
    );
  });
});

describe('replaced pointer', () => {
  it('renders the full shape in order', () => {
    expect(
      renderReplacedPointer({
        path: '/tmp/a.log',
        totalSize: 50100,
        unit: 'chars',
        preserved: 50100,
        maxSize: 50000,
        toolName: 'Lookup',
        toolCallId: 'call_1',
      }),
    ).toBe(
      [
        'Tool output exceeded 50000 characters; the full output was saved to a file.',
        'tool_name: Lookup',
        'tool_call_id: call_1',
        'output_size_chars: 50100',
        'output_path: /tmp/a.log',
        READ_OUTPUT_HINT,
      ].join('\n'),
    );
  });

  it('renders the partial headline with both counts', () => {
    expect(
      renderReplacedPointer({
        path: '/tmp/a.log',
        totalSize: 25_000_000,
        unit: 'chars',
        preserved: 60_000,
        maxSize: 50000,
        toolName: 'Lookup',
        toolCallId: 'call_1',
      }),
    ).toContain(
      'Tool output exceeded 50000 characters; the first 60000 characters (of 25000000) were saved to a file.',
    );
  });

  it('renders the media headline', () => {
    expect(
      renderReplacedPointer({
        path: '/tmp/a.log',
        totalSize: 8192,
        unit: 'chars',
        preserved: 8192,
        maxSize: 8192,
        toolName: 'Lookup',
        toolCallId: 'call_1',
        hasMedia: true,
      }),
    ).toContain(
      'Tool output exceeded 8192 characters; the full text output was saved to a file (media parts stay attached to this result).',
    );
  });

  it('places the byte size after the char size, before the path', () => {
    const lines = renderReplacedPointer({
      path: '/tmp/a.log',
      totalSize: 10,
      unit: 'chars',
      preserved: 10,
      maxSize: 5,
      toolName: 'Lookup',
      toolCallId: 'call_1',
      byteSize: 10,
    }).split('\n');
    const charAt = lines.indexOf('output_size_chars: 10');
    const byteAt = lines.indexOf('output_size_bytes: 10');
    const pathAt = lines.indexOf('output_path: /tmp/a.log');
    expect(byteAt).toBe(charAt + 1);
    expect(pathAt).toBe(byteAt + 1);
  });

  it('omits the byte size when none is given', () => {
    expect(
      renderReplacedPointer({
        path: '/tmp/a.log',
        totalSize: 10,
        unit: 'chars',
        preserved: 10,
        maxSize: 5,
        toolName: 'Lookup',
        toolCallId: 'call_1',
      }),
    ).not.toContain('output_size_bytes');
  });

  it('renders a byte-unit pointer without a second byte line', () => {
    const rendered = renderReplacedPointer({
      path: '/tmp/a.log',
      totalSize: 10,
      unit: 'bytes',
      preserved: 10,
      maxSize: 5,
      toolName: 'Lookup',
      toolCallId: 'call_1',
    });
    expect(rendered).toContain('output_size_bytes: 10');
    expect(rendered.split('output_size_bytes:').length - 1).toBe(1);
  });
});

describe('unpersisted pointer', () => {
  it('renders four lines with neither a path nor a next step', () => {
    const rendered = renderUnpersistedPointer({
      totalSize: 60000,
      unit: 'chars',
      maxSize: 50000,
      toolName: 'Lookup',
      toolCallId: 'call_2',
    });
    expect(rendered).toBe(
      [
        'Tool output exceeded 50000 characters and could not be saved to a file; only this preview is available.',
        'tool_name: Lookup',
        'tool_call_id: call_2',
        'output_size_chars: 60000',
      ].join('\n'),
    );
    expect(rendered).not.toContain('output_path');
    expect(rendered).not.toContain('next_step');
  });
});
