import type { ContentPart } from '#human/llm/message';

export function extractText(content: readonly ContentPart[]): string {
  let text = '';
  for (const part of content) {
    if (part.type === 'text') {
      text += part.text;
    }
  }
  return text;
}

export function truncateTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let asciiCount = 0;
  let nonAsciiCount = 0;
  let end = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
    if (Math.ceil(asciiCount / 4) + nonAsciiCount > maxTokens) break;
    end += char.length;
  }
  return text.slice(0, end);
}

export function truncateTextToTokensFromEnd(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let asciiCount = 0;
  let nonAsciiCount = 0;
  let start = text.length;
  for (let i = text.length - 1; i >= 0; i--) {
    let isAscii = false;
    // oxlint-disable-next-line unicorn/prefer-code-point
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
      // oxlint-disable-next-line unicorn/prefer-code-point
      const high = text.charCodeAt(i - 1);
      if (high >= 0xd800 && high <= 0xdbff) {
        i--;
      }
    } else {
      isAscii = code <= 127;
    }
    if (isAscii) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
    if (Math.ceil(asciiCount / 4) + nonAsciiCount > maxTokens) break;
    start = i;
  }
  return text.slice(start);
}
