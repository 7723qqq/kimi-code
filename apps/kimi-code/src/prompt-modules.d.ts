// Raw-string imports for prompt sources. Vite/Vitest handles `?raw` natively;
// tsdown uses the shared `raw-text-plugin` for the same import shape. The
// declaration is needed when compiling workspace sources (e.g.
// agent-core-v2) that pull in `*.md?raw` modules from this app's context.
declare module '*?raw' {
  const content: string;
  export default content;
}
