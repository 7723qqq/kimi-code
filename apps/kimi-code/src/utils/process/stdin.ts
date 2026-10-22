import { createInterface } from 'node:readline';

export interface StdinSource {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  resume(): unknown;
}

export interface StdinDeps {
  readonly stdin?: StdinSource;
  readonly openLineReader?: (input: StdinSource) => AsyncIterable<string>;
}

const openReadlineSource = (input: StdinSource): AsyncIterable<string> =>
  createInterface({ input: input as unknown as NodeJS.ReadableStream, crlfDelay: Infinity });

export function readStdinText(deps: StdinDeps = {}): Promise<string> {
  const stdin = deps.stdin ?? process.stdin;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8').trim());
    });
    stdin.on('error', reject);
    stdin.resume();
  });
}

export async function* createStdinLineReader(deps: StdinDeps = {}): AsyncIterable<string> {
  const stdin = deps.stdin ?? process.stdin;
  const open = deps.openLineReader ?? openReadlineSource;
  for await (const line of open(stdin)) {
    yield line;
  }
}
