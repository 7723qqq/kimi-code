# @moonshot-ai/kimi-web

> **Note**: kimi-web is excluded from the pnpm workspace and does not maintain an independent changelog.
> It ships as part of the Kimi Code CLI release (see `apps/kimi-code/CHANGELOG.md`); entries below only cover the period when it was published separately.

## 0.1.2

### Patch Changes

- [#1085](https://github.com/MoonshotAI/kimi-code/pull/1085) [`f1fad72`](https://github.com/MoonshotAI/kimi-code/commit/f1fad7222ccd3f66c1cae6c5b9c009230227cd2f) - Fix stuttery streaming in the web chat by coalescing rapid token updates into a single render per frame.
