export async function* readJsonLines(path: string): AsyncGenerator<string> {
  const source = Bun.file(path);
  const stream = path.endsWith('.zst')
    ? source.stream().pipeThrough(new DecompressionStream('zstd'))
    : source.stream();
  const decoder = new TextDecoder('utf8');
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n', start)) {
      let line = pending.slice(start, end);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      yield line;
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    yield pending.endsWith('\r') ? pending.slice(0, -1) : pending;
  }
}
