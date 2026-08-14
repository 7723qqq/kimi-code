export default {
  counts: '{turns} turns · {steps} steps',
  llm: 'LLM {duration}',
  toolCall: 'Tool call {duration}',
  ttftAverage: 'TTFT avg {duration}',
  tokensPerSecond: '{throughput} tok/s',
  cacheHit: 'Cache hit {percent}%',
  tokens: 'Input {input} tok · Output {output} tok',
} as const;
