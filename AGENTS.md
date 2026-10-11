# kimi-code — Agent Entry Point

This repository's authoritative instructions live in **`DEVELOP.md`** files, renamed from `AGENTS.md` on purpose (commit `2907d1734d`) so they are read on demand instead of resident in every session's context. Nothing auto-loads them — read them.

- **[Root `DEVELOP.md`](DEVELOP.md)** — project map, tech stack, build/test commands, code style, working principles, and the code-review rules.
- **Nearest sub-directory `DEVELOP.md`** — read before changing code in that area: `apps/kimi-code`, `apps/kimi-inspect`, `docs/`, `packages/klient`, `packages/minidb`, `packages/pi-tui`.
- **Skills** — `.agents/skills/<name>/SKILL.md`, discovered from the project root. Run the `gen-changesets` skill before opening a PR.
- **In-flight work** — `specs/<name>/` (requirements / design / tasks / progress). `reports/` is gitignored output.
- **Fork policy** — this is a personal experimental fork: do not open PRs upstream, and keep every `package.json` `version` identical to `upstream/main` (changesets feed the changelog only; the fork does not cut releases).
- **Contributing** — [`CONTRIBUTING.md`](CONTRIBUTING.md) / [`CONTRIBUTING.zh-CN.md`](CONTRIBUTING.zh-CN.md).
