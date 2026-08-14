export default {
  counts: '{turns} 轮 · {steps} 步',
  llm: 'LLM {duration}',
  toolCall: '工具调用 {duration}',
  ttftAverage: '首 token {duration}',
  tokensPerSecond: '{tps} tok/s',
  cacheHit: '缓存命中 {percent}%',
  inputOutput: '输入 {input} · 输出 {output}',
} as const;
