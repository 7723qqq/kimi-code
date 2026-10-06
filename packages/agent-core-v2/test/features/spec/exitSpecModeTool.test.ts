import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentSpecService, type SpecData } from '#/features/spec/spec';
import { ExitSpecModeTool } from '#/features/spec/tools/exit-spec-mode/exitSpecModeTool';
import type { ToolExecution, ToolResult } from '#/tool/toolContract';

import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

const SPEC_DIR = '/ws/specs/spec-1';
const REQUIRED = ['requirements.md', 'design.md', 'tasks.md'] as const;

function completeSpec(
  contents: Partial<Record<(typeof REQUIRED)[number], string>> = {},
): SpecData {
  const files: Record<string, string> = {};
  const missing: SpecData['missing'][number][] = [];
  for (const name of REQUIRED) {
    const content = contents[name] ?? `# ${name}`;
    files[name] = content;
    if (content.trim().length === 0) missing.push(name);
  }
  return {
    id: 'spec-1',
    dir: SPEC_DIR,
    files,
    missing,
    complete: missing.length === 0,
    stage: 'implement',
    progress: '',
  };
}

function permissionMode(mode: IAgentPermissionModeService['mode']): IAgentPermissionModeService {
  return {
    _serviceBrand: undefined,
    mode,
    setMode: () => {},
    setModeAndBroadcast: () => {},
    onDidChangeMode: () => ({ dispose: () => {} }),
  };
}

interface SpecStubOptions {
  readonly status?: SpecData | null;
  readonly readText?: ReturnType<typeof vi.fn>;
}

function specService({ status = completeSpec(), readText }: SpecStubOptions = {}): {
  readonly service: IAgentSpecService;
  readonly exit: ReturnType<typeof vi.fn>;
  readonly recordRevision: ReturnType<typeof vi.fn>;
} {
  const exit = vi.fn();
  const recordRevision = vi.fn(async () => {});
  const service: IAgentSpecService = {
    _serviceBrand: undefined,
    enter: vi.fn(async () => {}),
    cancel: vi.fn(),
    exit,
    clear: vi.fn(async () => {}),
    recordRevision,
    status: vi.fn(async () => status),
    activeSpecDir: () => (status === null ? null : status.dir),
  };
  void readText;
  return { service, exit, recordRevision };
}

function toolFor(options: {
  readonly mode?: IAgentPermissionModeService['mode'];
  readonly spec?: SpecStubOptions;
  readonly records: TelemetryRecord[];
}): {
  readonly tool: ExitSpecModeTool;
  readonly exit: ReturnType<typeof vi.fn>;
  readonly recordRevision: ReturnType<typeof vi.fn>;
  readonly readText: ReturnType<typeof vi.fn>;
} {
  const readText = options.spec?.readText ?? vi.fn(async (path: string) => `# ${path}`);
  const { service, exit, recordRevision } = specService({ ...options.spec, readText });
  const tool = new ExitSpecModeTool(
    service,
    permissionMode(options.mode ?? 'manual'),
    recordingTelemetry(options.records),
  );
  return { tool, exit, recordRevision, readText };
}

async function runTool(tool: ExitSpecModeTool): Promise<ToolResult> {
  const execution: ToolExecution = await tool.resolveExecution({});
  if ('isError' in execution && execution.isError === true) {
    throw new Error('expected a runnable execution');
  }
  return execution.execute({
    turnId: 0,
    toolCallId: 'call_exit_spec_mode',
    signal: new AbortController().signal,
  });
}

function eventsNamed(records: TelemetryRecord[], name: string): TelemetryRecord[] {
  return records.filter((record) => record.event === name);
}

describe('ExitSpecModeTool telemetry and read cost', () => {
  let records: TelemetryRecord[];

  beforeEach(() => {
    records = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits exactly one spec_submitted per exit', async () => {
    const { tool } = toolFor({ records });

    await runTool(tool);

    expect(eventsNamed(records, 'spec_submitted')).toHaveLength(1);
  });

  it('reports the number of documents with content', async () => {
    const { tool } = toolFor({
      records,
      spec: { status: completeSpec({ 'requirements.md': '# Requirements' }) },
    });

    await runTool(tool);

    expect(eventsNamed(records, 'spec_submitted')[0]?.properties?.['file_count']).toBe(3);
  });

  it('emits no submission when a required document is empty', async () => {
    const { tool, exit } = toolFor({
      records,
      spec: { status: completeSpec({ 'design.md': '  \n ' }) },
    });

    const result = await runTool(tool);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('design.md');
    expect(eventsNamed(records, 'spec_submitted')).toHaveLength(0);
    expect(exit).not.toHaveBeenCalled();
  });

  it('does not report an auto-approved spec as approved', async () => {
    const { tool } = toolFor({ records, mode: 'auto' });

    await runTool(tool);

    const outcomes = eventsNamed(records, 'spec_resolved').map(
      (record) => record.properties?.['outcome'],
    );
    expect(outcomes).toEqual(['approved_without_review']);
    expect(outcomes).not.toContain('approved');
  });

  it('reports a reviewed spec as approved', async () => {
    const { tool } = toolFor({ records, mode: 'manual' });

    await runTool(tool);

    expect(eventsNamed(records, 'spec_resolved')[0]?.properties?.['outcome']).toBe('approved');
  });

  it('names the progress file in the handoff on the non-interactive path', async () => {
    const { tool } = toolFor({ records, mode: 'manual' });

    const result = await runTool(tool);

    expect(result.output).toContain('tasks.md');
    expect(result.output).toContain('progress.md');
  });

  it('names the progress file in the handoff on the auto path', async () => {
    const { tool } = toolFor({ records, mode: 'auto' });

    const result = await runTool(tool);

    // The auto path deliberately withholds the "work through tasks.md"
    // instruction — the user never approved execution.
    expect(result.output).not.toContain('Work through');
    expect(result.output).toContain('progress.md');
  });
});
