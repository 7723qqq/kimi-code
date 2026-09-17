// Raw-string imports for prompt sources. Vite/Vitest handles `?raw` natively;
// tsdown uses the shared `raw-text-plugin` for the same import shape. No
// source in this app imports `*.md?raw` today.
declare module '*?raw' {
  const content: string;
  export default content;
}
