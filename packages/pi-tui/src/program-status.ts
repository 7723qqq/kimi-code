export interface ProgramStatus {
  state: 'idle' | 'working' | 'blocked' | 'done' | 'error' | 'clear';
  app?: string;
  kind?: 'permission' | 'question' | 'auth';
  id?: string;
  title?: string;
  message?: string;
}

export const PROGRAM_STATUS_QUERY = '\x1b]7501;?\x1b\\';

export function isProgramStatusReply(sequence: string): boolean {
  return /^\x1b\]7501;\?[^\x07\x1b]*(?:\x07|\x1b\\)$/.test(sequence);
}

const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const ID_PATTERN = /^[A-Za-z0-9_.+-]{1,32}(?:\/[A-Za-z0-9_.+-]{1,32}){0,7}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;
const MAX_TITLE_BYTES = 192;
const MAX_MESSAGE_BYTES = 2048;

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

function encodeText(text: string | undefined, maxBytes: number): string | undefined {
  const value = truncateUtf8((text ?? '').replace(CONTROL_CHARACTERS, ' ').trim(), maxBytes);
  return value ? Buffer.from(value, 'utf8').toString('base64') : undefined;
}

export function formatProgramStatus(status: ProgramStatus): string {
  if (status.id !== undefined && (status.id.length > 128 || !ID_PATTERN.test(status.id))) {
    throw new RangeError('Invalid program status id');
  }
  const pairs = [`state=${status.state}`];
  if (status.app !== undefined && APP_PATTERN.test(status.app)) pairs.push(`app=${status.app}`);
  if (status.state === 'blocked' && status.kind) pairs.push(`kind=${status.kind}`);
  if (status.id !== undefined) pairs.push(`id=${status.id}`);
  const title = encodeText(status.title, MAX_TITLE_BYTES);
  if (title !== undefined) pairs.push(`title=${title}`);
  const message = encodeText(status.message, MAX_MESSAGE_BYTES);
  if (message !== undefined) pairs.push(`msg=${message}`);
  return `\x1b]7501;${pairs.join(':')}\x1b\\`;
}
