# @moonshot-ai/i18n-shared

## 0.2.0

### Minor Changes

- [`fe6f861`](https://github.com/MoonshotAI/kimi-code/commit/fe6f861758d64101a8b142ad0fa01874a3b5b133) - Add shared i18n package (`@moonshot-ai/i18n-shared`) with unified translation engine, locale detection, and type-safe key paths. Migrate all Node.js apps to the Rust-backed cached translator and browser apps to the shared pure-JS engine.

### Patch Changes

- [`c4727ec`](https://github.com/MoonshotAI/kimi-code/commit/c4727ec5c02501267da084ef8af92989855d91b9) Thanks [@7723qqq](https://github.com/7723qqq)! - Use the Rust native translation engine in the shared i18n package with automatic fallback to pure JS when the native module is unavailable, and deprecate `@moonshot-ai/i18n-shared/node`.
