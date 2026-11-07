import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { AssociativeMemoryService } from '#/features/associativeMemory/service';
import { stubBootstrap } from '../test/app/bootstrap/stubs';

const DAY = 24 * 60 * 60 * 1000;

function buildService(homeDir: string): { service: AssociativeMemoryService; advance: (ms: number) => void } {
  let now = 1_000;
  const bootstrap = { ...stubBootstrap(homeDir), cwd: join(homeDir, 'project') };
  const service = new (class extends AssociativeMemoryService {
    constructor() {
      super(
        bootstrap as never,
        { enabled: () => true } as never,
        { debug() {}, info() {}, warn() {}, error() {} } as never,
        { register: () => ({ dispose() {} }) } as never,
        { get: () => [] } as never,
        { cwd: join(homeDir, 'project') } as never,
        { revision: 0, list: async () => [] as string[], get: async () => undefined } as never,
      );
    }
    protected override now(): number {
      return now;
    }
    advance(ms: number): void {
      now += ms;
    }
  })();
  return { service, advance: (ms: number) => (service as never as { advance: (m: number) => void }).advance(ms) };
}

const TOTAL = 200;
const homeDir = await mkdtemp(join(os.tmpdir(), 'durability-'));
const { service, advance } = buildService(homeDir);

const subjects = Array.from({ length: TOTAL }, (_, index) => `topic${index} marker${index}`);
for (const [index, text] of subjects.entries()) {
  await service.writeNote(text);
  if (index % 40 === 39) advance(DAY);
}

async function recallable(): Promise<number> {
  let hits = 0;
  for (const [index, text] of subjects.entries()) {
    const cue = `topic${index}`;
    const recalled = await service.recall({
      cue,
      limit: 5,
      maxTokens: undefined,
      includeHistory: false,
    });
    if (recalled.items.some((item) => item.text.includes(text.split(' ')[1]!))) hits += 1;
  }
  return hits;
}

const atWrite = await recallable();
const statsAtWrite = await service.stats('project');

advance(30 * DAY);
await service.rebuild();
const atThirty = await recallable();
const statsThirty = await service.stats('project');

advance(365 * DAY);
await service.rebuild();
const atYear = await recallable();
const statsYear = await service.stats('project');

console.log(`notes written        ${TOTAL}`);
console.log(`recallable at write  ${atWrite}/${TOTAL}   ${JSON.stringify(statsAtWrite)}`);
console.log(`recallable +30d      ${atThirty}/${TOTAL}   ${JSON.stringify(statsThirty)}`);
console.log(`recallable +395d     ${atYear}/${TOTAL}   ${JSON.stringify(statsYear)}`);

service.dispose();
await rm(homeDir, { recursive: true, force: true });
