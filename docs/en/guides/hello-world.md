# hello-world dev workflow mode

hello-world mode is a staged development run — a development workflow with phase gates. Turning the mode on starts a run: the run advances through 7 stages — `requirements` → `design` → `implement` → `test` → `review` → `docs` → `deliver` — and each stage has its own goal, an injected playbook for the model, and exit evidence.

Unlike parallel-execution modes such as swarm and Tower, hello-world covers the **full lifecycle of a single development task**: from confirming requirements all the way to delivery and wrap-up. The run's artifacts land in the four files under `specs/<id>/`. The run survives across turns — when one conversation turn ends, the mode and stage state remain until you exit with `/hello-world off`.

While the mode is on, the footer shows a `hello-world:<stage>` badge, and the model receives the current stage's playbook every turn; `/status` shows the current stage, and `/hello-world status` shows the run's full progress.

## When hello-world fits

Whether to use hello-world mainly depends on whether the task needs a complete development lifecycle, not just "get the code changed".

Good candidates include:

- The task has a clear chain from requirements to delivery: fix the acceptance criteria first, then design, implement, test, review, update docs, and land a changeset
- You want every stage backed by checkable evidence instead of gut feeling
- The task spans multiple turns, and you need to check progress, advance manually, or skip individual checklist items along the way

## The seven stages

Each stage has explicit output requirements; once its exit evidence is met the run advances to the next stage automatically, and you can also advance manually.

| Stage | What it does | Core artifacts |
| --- | --- | --- |
| `requirements` | Clarify requirements and acceptance criteria | `specs/<id>/requirements.md` |
| `design` | Produce the design and break down tasks | `specs/<id>/design.md`, `specs/<id>/tasks.md` |
| `implement` | Implement with small, focused commits | Code, focused commits |
| `test` | Run tests and local gates | Test execution evidence |
| `review` | Review the code and resolve findings | Review findings record |
| `docs` | Update user documentation | `docs/`, `README*` updates |
| `deliver` | Run delivery gates and land the changeset | Changeset, commit, push |

Maintenance (maintain) is not a stage inside the run — it is the closing loop: when you exit the run, leftover items are archived under four maintenance categories and flow back as requirement seeds for the next run.

## Subcommands

All forms of `/hello-world` are only available in the idle state.

| Command | Action | Availability |
| --- | --- | --- |
| `/hello-world` | Flip the mode (on ↔ off) | Idle only |
| `/hello-world on\|off` | Explicitly turn the mode on or off without sending a prompt; with `off`, unfinished checklist items are listed as a warning first (the turn-off still happens) | Idle only |
| `/hello-world <task>` | Turn the mode on and send `<task>` as a normal prompt, recording it as this run's task; in the Always Ask permission mode, Kimi Code asks whether to switch to Ask When Needed or Never Ask before starting | Idle only |
| `/hello-world status` | Show the run panel: stage, task, checklist items with evidence, and waivers | Idle only |
| `/hello-world next` | Manually advance to the next stage; does nothing on the last stage (`deliver`) | Idle only |
| `/hello-world phase <stage>` | Jump to the given stage; stages only move forward | Idle only |
| `/hello-world skip <item>` | Waive one checklist item and record it (the item is marked `waived`) | Idle only |

## Run artifacts

The run's artifacts land in the `specs/<id>/` directory (`<id>` is this run's identifier) as four files:

- **`requirements.md`**: requirements and acceptance criteria
- **`design.md`**: design decisions and trade-offs
- **`tasks.md`**: task breakdown and execution steps
- **`progress.md`**: progress, open items, and the closing summary

hello-world shares the `specs/` directory with [Spec mode](../reference/tools.md#spec-mode), but each `<id>` is an independent directory and they never overwrite each other. Evidence matching uses the `specs/*/filename` glob and does not depend on a specific `<id>`.

## Evidence-based stage advancement

The run observes tool calls and advances stages automatically according to this evidence table (a write is a `Write`/`Edit` tool call):

| Signal | From stage | Advances to | Also checks off |
| --- | --- | --- | --- |
| Write `specs/*/requirements.md` | `requirements` | `design` | `requirements-approved` |
| Write `specs/*/design.md` or `specs/*/tasks.md` | `design` | `implement` | `design-written`, `tasks-complete` |
| Write a code path (not `specs/`, `docs/`, or `.changeset/`) | `requirements`, `design` | `implement` | — |
| Successfully run a gate command such as `bun test`, `bun run lint`, `bun run typecheck`, or `check:*` | `implement` | `test` | — |
| The same command succeeds while in `test` | `test` | `review` | `tests-green` |
| Write `docs/**` or `README*` | `review` | `docs` | `review-done` |
| Write `.changeset/*.md` | `docs` | `deliver` | `docs-updated`, `changeset-ready` |

Advancement rules: stages only move forward; repeated signals are idempotent (they never advance twice); manual advancement (`next` / `phase`) carries the same weight as automatic advancement. Automatic detection is conservative — a misjudgment never blocks you and is not a hard gate; fall back to `next` / `phase` as needed.

## Checklist and closing summary

Every run carries a 7-item checklist matching each stage's exit evidence:

- `requirements-approved` — requirements confirmed
- `design-written` — design written down
- `tasks-complete` — task breakdown complete
- `tests-green` — tests green
- `review-done` — review complete
- `docs-updated` — documentation updated
- `changeset-ready` — changeset ready

Matching evidence checks items off automatically; items that cannot be judged automatically are waived with `/hello-world skip <item>`, which records them as `waived` and keeps a waiver trail. `/hello-world status` always shows each item's state, evidence, and waivers.

When you exit the run (`/hello-world off`), a closing-summary guide is injected: list the open items, write progress to `specs/<id>/progress.md`, archive leftover items under the four maintenance categories (corrective, adaptive, perfective, preventive), and distill requirement seeds for the next run.

## Mode exclusivity

hello-world is exclusive with Spec, Swarm, and Tower: turning on hello-world leaves whichever of those three was active, and entering any of them turns hello-world off. Plan and hello-world can run together. `Shift-Tab` only cycles between Plan and Spec and never touches hello-world — use `/hello-world` to toggle it.

For the full mutual-exclusion rules, see [Slash Commands](../reference/slash-commands.md#modes-run-control).

## Next steps

- [Slash Commands](../reference/slash-commands.md#modes-run-control) — All the `/hello-world` forms
- [Built-in Tools](../reference/tools.md#spec-mode) — Spec mode and the other `specs/` convention
- [Tower multi-agent collaboration](./tower.md) — The experimental mode for multi-agent parallel execution
