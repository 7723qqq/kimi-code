const benchResults: string[] = [];
let benchGroup = '';

export function describe(name: string, fn: () => void): void {
  const previous = benchGroup;
  benchGroup = previous.length > 0 ? `${previous} > ${name}` : name;
  fn();
  benchGroup = previous;
}

export function bench(name: string, fn: () => void, options: { readonly iterations?: number; readonly time?: number; readonly warmupTime?: number } = {}): void {
  const iterations = options.iterations ?? 50;
  for (let i = 0; i < 5; i += 1) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) fn();
  const meanMs = (performance.now() - start) / iterations;
  const label = benchGroup.length > 0 ? `${benchGroup} > ${name}` : name;
  benchResults.push(`${label.padEnd(78)} ${meanMs.toFixed(3)} ms/op`);
}

export function reportBenchResults(): void {
  console.log(benchResults.join('\n'));
}
