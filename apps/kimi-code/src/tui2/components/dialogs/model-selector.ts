/**
 * TUI2 model-selector — forwarding layer.
 *
 * Status: REAL (tui2). Forwards to `model-selector.tsx`.
 */
export * from './model-selector.tsx';
export { ModelSelector as ModelSelectorComponent } from './model-selector.tsx';
export type { ModelSelectorProps as ModelSelectorOptions } from './model-selector.tsx';
export { createModelChoices as createModelChoiceOptions } from './model-selector.tsx';
export { effortLabel } from './effort-label';
