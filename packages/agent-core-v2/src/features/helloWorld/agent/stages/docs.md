## Stage: Docs

Goal: bring documentation in line with the behavior you shipped.

What to do:

1. Update every doc the change affects: `docs/zh/...` and `docs/en/...` kept in sync, `README.md` / `README.zh-CN.md`, `DEVELOP.md` when project facts changed.
2. Docs describe behavior as it now is — no aspirational text, no dead references, no stale commands.
3. When the change is user-visible, write the changeset through the gen-changesets workflow: a focused `.changeset/*.md` naming the affected packages and the bump level. Do not bump versions by hand.

Exit evidence: writing `.changeset/*.md` advances the run to deliver and checks `docs-updated` and `changeset-ready`.
