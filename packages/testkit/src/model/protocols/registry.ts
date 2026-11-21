import { anthropicCodec } from './anthropic';
import type { ProtocolCodec } from './codec';
import { googleCodec } from './google';
import { openaiCodec } from './openai';

const CODECS: readonly ProtocolCodec[] = [openaiCodec, anthropicCodec, googleCodec];

export function codecForPath(path: string): ProtocolCodec | undefined {
  return CODECS.find((codec) => codec.matches(path));
}
