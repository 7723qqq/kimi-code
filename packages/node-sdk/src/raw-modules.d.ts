// Raw-string imports for prompt sources. Vite/Vitest handles `?raw` natively;
// tsdown uses the shared `raw-text-plugin` for the same import shape. Local
// copy of agent-core's `prompt-modules.d.ts` (the v1 package is being removed;
// the declaration is needed for agent-core-v2 deep imports that pull in
// `*.md?raw` modules).
declare module '*?raw' {
  const content: string;
  export default content;
}
