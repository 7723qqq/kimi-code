import type { ContentPart, ToolCall, ToolDescription } from '#/llm/message';

import type { ImageTokenPricing } from '#/llm/modelFamily';

export interface EstimableMessage {
  readonly role: string;
  readonly content: readonly ContentPart[];
  readonly toolCalls?: readonly ToolCall[];
}

const messageTokenEstimateCache = new WeakMap<EstimableMessage, number>();

export const MEDIA_TOKEN_ESTIMATE = 2000;

/**
 * Estimate image tokens for a family's vision accounting.
 *
 * This is a heuristic derived from the family constants, calibrated against a
 * live endpoint — not a reproduction of a published spec, and therefore not
 * exact. The families that use it do not publish a formula. `fallbackTokens`
 * (used when dimensions are unknown) and `tokenCap` (the grid ceiling) are
 * independent knobs: see the pricing tests that pin them separately.
 */
export function imageTokensFor(
  pricing: ImageTokenPricing,
  dimensions?: { readonly width: number; readonly height: number },
): number {
  const { patchPx, downsampleRatio, scaleUpFloorPx, tokenCap, fallbackTokens } = pricing;
  if (dimensions === undefined) return fallbackTokens;
  let width = dimensions.width;
  let height = dimensions.height;
  if (!(width > 0) || !(height > 0)) return fallbackTokens;
  const cell = patchPx * downsampleRatio;
  const shortEdge = Math.min(width, height);
  if (shortEdge < scaleUpFloorPx) {
    const scale = scaleUpFloorPx / shortEdge;
    width *= scale;
    height *= scale;
  }
  let cols = Math.max(1, Math.ceil(width / cell));
  let rows = Math.max(1, Math.ceil(height / cell));
  for (let step = 0; step < 8 && cols * rows > tokenCap; step += 1) {
    const scale = Math.sqrt(tokenCap / (cols * rows));
    width *= scale;
    height *= scale;
    cols = Math.max(1, Math.ceil(width / cell));
    rows = Math.max(1, Math.ceil(height / cell));
  }
  return Math.min(cols * rows, tokenCap);
}

export function estimateTokens(text: string): number {
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }
  return Math.ceil(asciiCount / 4) + nonAsciiCount;
}

export function estimateTokensForMessages(
  messages: readonly EstimableMessage[],
  pricing?: ImageTokenPricing,
): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokensForMessage(message, pricing);
  }
  return total;
}

export function estimateTokensForTools(tools: readonly ToolDescription[]): number {
  let total = 0;
  for (const tool of tools) {
    total += estimateTokens(tool.name);
    total += estimateTokens(tool.description);
    total += estimateTokens(JSON.stringify(tool.parameters));
  }
  return total;
}

export function estimateTokensForMessage(
  message: EstimableMessage,
  pricing?: ImageTokenPricing,
): number {
  if (pricing === undefined) {
    const cached = messageTokenEstimateCache.get(message);
    if (cached !== undefined) {
      return cached;
    }
  }

  let total = estimateTokens(message.role);
  total += estimateTokensForContentParts(message.content, pricing);
  if (message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      total += estimateTokens(call.name);
      total += estimateTokens(JSON.stringify(call.arguments));
    }
  }
  if (pricing === undefined) {
    messageTokenEstimateCache.set(message, total);
  }
  return total;
}

export function estimateTokensForContentParts(
  parts: readonly ContentPart[],
  pricing?: ImageTokenPricing,
): number {
  let total = 0;
  for (const part of parts) {
    total += estimateTokensForContentPart(part, pricing);
  }
  return total;
}

export function estimateTokensForContentPart(
  part: ContentPart,
  pricing?: ImageTokenPricing,
): number {
  switch (part.type) {
    case 'text':
      return estimateTokens(part.text);
    case 'think':
      return estimateTokens(part.think);
    case 'image_url':
      return pricing === undefined
        ? MEDIA_TOKEN_ESTIMATE
        : imageTokensFor(pricing, part.imageUrl.dimensions);
    case 'audio_url':
    case 'video_url':
      return MEDIA_TOKEN_ESTIMATE;
    default: {
      const exhaustive: never = part;
      void exhaustive;
      return 0;
    }
  }
}
