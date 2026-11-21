import type { ToolDescription } from '@moonshot-ai/core/llm/message';

export interface LoopProfile {
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolDescription[];
}
