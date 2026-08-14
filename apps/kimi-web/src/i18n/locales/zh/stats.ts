export default {
  counts: '{turns} 轮 · {steps} 步',
  llm: 'LLM {duration}',
  toolCall: '工具调用 {duration}',
  ttftAverage: '首 token 平均 {duration}',
  tokensPerSecond: '{throughput} tok/s',
  cacheHit: '缓存命中 {percent}%',
  tokens: '输入 {input} tok · 输出 {output} tok',
} as const;
