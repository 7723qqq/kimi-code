import { afterEach } from 'bun:test';

import { recordReportEvent, setActiveReportCase } from '../harness/report.js';

const failedCases = new Set<string>();
let currentCase: string | undefined;

afterEach(() => {
  const caseName = currentCase;
  currentCase = undefined;
  if (caseName === undefined || failedCases.has(caseName)) return;
  recordReportEvent({ kind: 'test-result', caseName, state: 'passed' });
});

export function markCaseFailed(caseName: string, error: unknown): void {
  failedCases.add(caseName);
  recordReportEvent({
    kind: 'test-result',
    caseName,
    state: 'failed',
    error: errorForLog(error),
  });
}

export function createCaseLogger(caseName: string): (label: string, value?: unknown) => void {
  setActiveReportCase(caseName);
  currentCase = caseName;
  return (label, value) => {
    recordReportEvent({ kind: 'log', caseName, label, value });
    const prefix = `[server-e2e] ${caseName} :: ${label}`;
    if (value === undefined) {
      writeLogLine(prefix);
      return;
    }
    writeLogLine(`${prefix}\n${stringifyForLog(value)}`);
  };
}

export function errorForLog(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...objectFields(error),
    };
  }
  return error;
}

function objectFields(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

function stringifyForLog(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function writeLogLine(line: string): void {
  process.stdout.write(`${line}\n`);
}
