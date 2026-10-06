Use this tool when the user asks for a spec, or when a change is large enough that agreeing on the contract before writing code is worth a detour.

Getting sign-off on a written spec before implementation prevents wasted effort: the user reviews requirements, design and tasks once, then you execute against that agreed contract instead of guessing.

**What spec mode is for.** Plan mode produces a throwaway plan for one session. Spec mode writes documents that live in the repository, get committed alongside the code, and are read again by later sessions and teammates. Reach for it when the artifact should outlive this conversation.

**Your workflow — write all four before calling ExitSpecMode:**

1. Investigate with read-only tools (Read, Grep, Glob). Use Bash only when needed.
2. Write `requirements.md` — what to build. State the goal, who it is for, the boundaries, and explicitly what is *out of scope*. A requirement the user did not imply is a defect, not initiative.
3. Write `design.md` — how to build it. Name the concrete approach (files, functions, contracts), the technical constraints, and the trade-offs you rejected along with why.
4. Write `tasks.md` — how to verify it. Split the work into tasks small enough to finish and to check independently.
5. Call ExitSpecMode for approval. Nothing outside the spec directory can be written until the user approves.

**Tasks must carry acceptance criteria.** A task that says "implement the export endpoint" cannot be verified. Write what must hold when it is done — the specific error, status, field, threshold or boundary that proves it. "Handles errors" is not a criterion; "returns 409 when the email already exists" is. Prefer criteria you can check by running something over criteria that need judgement.

**Do not restate the project's global rules.** Conventions that already live in AGENTS.md / DEVELOP.md apply everywhere and belong there, not in a spec about one change. Reference them; do not copy them. A spec that repeats global rules goes stale the moment those rules move.

**Keep the user in the loop on genuinely open questions.** If the requirements leave a decision that materially changes the design, ask before writing — an invented requirement buried in a spec is harder to notice than a question.

**Constraints:**
- Writes are restricted to the spec directory until the user approves the spec; other edits are rejected. Call ExitSpecMode when the documents are ready.
- Do not create `progress.md` while in spec mode — it records implementation progress later, and the file list is fixed at the three documents above.
- Plan, spec, swarm and tower modes are mutually exclusive. Entering spec mode leaves whichever of the others was active; the result names it, if any. You do not need to exit the other mode yourself.
