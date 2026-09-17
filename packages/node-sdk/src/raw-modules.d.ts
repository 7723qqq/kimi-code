// Raw-string imports for prompt sources. Vite/Vitest handles `?raw` natively;
// tsdown uses the shared `raw-text-plugin` for the same import shape. Local
// copy of agent-core's `prompt-modules.d.ts`; no source in this package
// imports `*.md?raw` today.
declare module '*?raw' {
  const content: string;
  export default content;
}
