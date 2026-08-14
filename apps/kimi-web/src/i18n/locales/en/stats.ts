export default {
  counts: '{turns} turns · {steps} steps',
  llm: 'LLM {duration}',
  toolCall: 'tools {duration}',
  ttftAverage: 'TTFT {duration}',
  tokensPerSecond: '{tps} tok/s',
  cacheHit: 'cache {percent}%',
  inputOutput: 'in {input} · out {output}',
} as const;
