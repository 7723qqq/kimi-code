import type { ContentPart, StreamedMessagePart } from './message';
type Tag = 'think' | 'thinking';

const TAG_NAMES: readonly Tag[] = ['think', 'thinking'];
const MAX_TAG_LENGTH = 64;
const MAX_TAG_DEPTH = 32;

export function createThinkingTagParser(): ThinkingTagParser {
  return new ThinkingTagParser();
}

class ThinkingTagParser {
  private tags: Tag[] = [];
  private pending = '';
  private inlineTicks = 0;
  private fence: { character: string; count: number } | undefined;
  private delimiter: { character: string; count: number; lineStart: boolean } | undefined;
  private closingFence = false;
  private lineIndent = 0;
  private indentedLine = false;
  private escaped = false;
  private jsonDepth = 0;
  private jsonString = false;

  push(part: StreamedMessagePart): StreamedMessagePart[] {
    if (part.type === 'think' && part.think.length === 0 && part.encrypted === undefined)
      return [part];
    if (
      part.type !== 'text' ||
      Object.values(part.meta ?? {}).some((value) => value !== undefined)
    ) {
      return [...this.finish(), part];
    }
    const output: ContentPart[] = [];
    let text = '';
    let thinking = this.tags.length > 0;
    const flush = (): void => {
      if (text.length === 0) return;
      output.push(thinking ? { type: 'think', think: text } : { type: 'text', text });
      text = '';
    };
    const literal = (value: string): void => {
      text += value;
      for (const character of value) this.advance(character);
    };

    for (const character of part.text) {
      if (this.pending.length > 0) {
        this.pending += character;
        const match = /^<(\/?)(think|thinking)[ \t]*>$/i.exec(this.pending);
        if (match !== null) {
          const tag = match[2]!.toLowerCase() as Tag;
          const closing = match[1] === '/';
          if (closing ? this.tags.at(-1) === tag : this.tags.length < MAX_TAG_DEPTH) {
            flush();
            if (closing) this.tags.pop();
            else this.tags.push(tag);
            thinking = this.tags.length > 0;
            this.lineIndent = -1;
            this.escaped = false;
          } else {
            literal(this.pending);
          }
          this.pending = '';
          continue;
        }
        if (tagPrefix(this.pending)) continue;
        literal(this.pending.slice(0, -1));
        this.pending = '';
      }
      if (this.delimiter !== undefined && this.delimiter.character !== character) {
        this.finishDelimiter();
      }
      if (
        character === '<' &&
        this.fence === undefined &&
        this.inlineTicks === 0 &&
        !this.jsonString &&
        !this.indentedLine &&
        this.lineIndent < 4 &&
        !this.escaped
      ) {
        this.pending = '<';
        continue;
      }
      if (
        (character === '`' || character === '~') &&
        !this.jsonString &&
        (!this.escaped || this.inlineTicks > 0 || this.fence !== undefined)
      ) {
        if (this.delimiter?.character === character) this.delimiter.count += 1;
        else
          this.delimiter = {
            character,
            count: 1,
            lineStart: this.lineIndent >= 0 && this.lineIndent < 4,
          };
      }
      literal(character);
    }
    flush();
    return output;
  }

  finish(): ContentPart[] {
    const pending = this.pending;
    const thinking = this.tags.length > 0;
    this.tags = [];
    this.pending = '';
    this.inlineTicks = 0;
    this.fence = undefined;
    this.delimiter = undefined;
    this.closingFence = false;
    this.lineIndent = 0;
    this.indentedLine = false;
    this.escaped = false;
    this.jsonDepth = 0;
    this.jsonString = false;
    if (pending.length === 0) return [];
    return [thinking ? { type: 'think', think: pending } : { type: 'text', text: pending }];
  }

  private finishDelimiter(): void {
    const delimiter = this.delimiter;
    this.delimiter = undefined;
    if (delimiter === undefined) return;
    if (this.fence !== undefined) {
      this.closingFence =
        delimiter.lineStart &&
        delimiter.character === this.fence.character &&
        delimiter.count >= this.fence.count;
    } else if (this.inlineTicks === 0 && delimiter.lineStart && delimiter.count >= 3) {
      this.fence = { character: delimiter.character, count: delimiter.count };
    } else if (delimiter.character === '`') {
      if (this.inlineTicks === 0) this.inlineTicks = delimiter.count;
      else if (this.inlineTicks === delimiter.count) this.inlineTicks = 0;
    }
  }

  private advance(character: string): void {
    if (this.inlineTicks === 0 && this.fence === undefined && this.delimiter === undefined) {
      if (character === '"' && this.jsonDepth > 0 && !this.escaped)
        this.jsonString = !this.jsonString;
      else if (!this.jsonString) {
        if (character === '{' || character === '[') this.jsonDepth += 1;
        else if (character === '}' || character === ']')
          this.jsonDepth = Math.max(0, this.jsonDepth - 1);
      }
    }
    if (character === '\n' || character === '\r') {
      if (this.closingFence) this.fence = undefined;
      this.closingFence = false;
      this.lineIndent = 0;
      this.indentedLine = false;
      this.escaped = false;
      return;
    }
    if (character !== ' ' && character !== '\t') this.closingFence = false;
    if (this.lineIndent >= 0) {
      if (character === ' ') this.lineIndent += 1;
      else if (character === '\t') this.lineIndent += 4;
      else {
        this.indentedLine = this.lineIndent >= 4;
        this.lineIndent = -1;
      }
    }
    this.escaped = character === '\\' && !this.escaped;
  }
}

function tagPrefix(value: string): boolean {
  if (value.length > MAX_TAG_LENGTH) return false;
  const body = value.slice(value.startsWith('</') ? 2 : 1).toLowerCase();
  return TAG_NAMES.some(
    (tag) =>
      tag.startsWith(body) || (body.startsWith(tag) && /^[ \t]*$/.test(body.slice(tag.length))),
  );
}

function isJsonContent(content: readonly ContentPart[]): boolean {
  const text = content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trimStart();
  if (!text.startsWith('{') && !text.startsWith('[')) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function normalizeThinkingTags(content: readonly ContentPart[]): ContentPart[] {
  if (isJsonContent(content)) return [...content];
  const parser = createThinkingTagParser();
  const parts: ContentPart[] = [];
  for (const part of content) parts.push(...(parser.push(part) as ContentPart[]));
  parts.push(...parser.finish());
  return parts;
}
