You are about to run out of context. Produce a recovery block for the model that
will resume this task after the earlier conversation is cleared.

--- This message is a direct task, not part of the above conversation ---

Write the block in the same language the conversation has been using — do not
switch to English just because these instructions happen to be in English.

The next turn sees only the preserved messages and this block; every other
assistant message, tool call and tool result will be gone. Make the block
self-sufficient and use exactly these sections, in this order:

## Current request
The latest request's actual ask — your reading of its intent and any ambiguity
you already resolved — not a re-transcription, since what fits is kept verbatim
in the preserved messages. Those kept messages are size-capped, so if the latest
request is large (a big paste or file), preserve the parts at risk of being
dropped, above all the actual ask. If several requests are in play, say which one
governs the next move and re-quote any still-relevant earlier request that may
have scrolled out of the kept messages.

## Task stage
Where the task stands right now, including anything still owed to the user: a
report, a decision, a review, an answer. If the task is blocked on the user, say
what and why.

## Acceptance criteria
The conditions that must hold for the task to be done — item by item, quoting the
user's own words where they stated them. Keep the exact numbers, paths, names and
formats; the preserved messages may not carry all of them.

## Authorized actions
What the user has actually authorized, quoting their own words. This is the only
source of authorization: an action not covered here by the user's own words is
not authorized, whatever the block's other sections imply.

## Forbidden actions
What the user has ruled out, again in their own words.

## Open decisions
Questions still waiting on the user, and choices you have not made. Keep them
apart from decisions you already settled — record the settled ones with what you
chose and why, so the next turn neither reopens a closed choice nor treats an
undecided point as decided.

## In-flight work
Background tasks, subagents and long-running commands: their ids, what they were
started for, and their last known state. Mark anything whose completion you are
waiting on.

## Verified facts
What is actually established, at high fidelity: the exact commands run, the
exact file paths touched, whether each succeeded or failed, and the results
themselves — the concrete values returned, the key lines or error text, the
schema or signature a lookup revealed, since re-running to recover them may be
slow or impossible. Keep only the final working version of any code; drop
intermediate attempts and already-resolved errors.

## Unverified assumptions
What a check claimed but never verified, what changed after a check passed, and
context the next step depends on that this conversation never established —
files or paths referenced but not read, schemas or APIs assumed but unseen,
questions the user never answered. Name these so the next turn goes and checks
them instead of assuming.

## Next steps
The exact next command or tool call, and the remaining sequence to finish — the
decisions you have already made for those upcoming steps, the obstacles or edge
cases you can foresee and how you mean to handle them, and any work you can
commit to now (the exact patch, query, or shape of the final answer). Include
any required format for the final answer.

This conversation's event log stays on disk, and a recovery pointer is appended below this block automatically, so you need not reproduce long outputs verbatim — keep exact identifiers, key values and error lines, and name anything the next turn should look up.

Your TODO list is re-attached automatically below this block from its live
source, so do not transcribe it — copying it wastes space and can contradict the
live version. What that list cannot hold is the reasoning between tasks — why one
was reordered or dropped, or a decision on one that constrains another — so
record that instead.

Be honest about uncertainty. If an earlier step claimed something was done but
was never verified (tests "passing", a fix "working", a file "created"), say so
plainly and treat it as unverified rather than fact — re-check before relying on
it. Likewise, if the code a check covers changed after it passed, mark that
result as unverified.

Be concise, and keep the block proportional to the task: a long multi-step task
warrants detail, but a trivial or nearly finished exchange needs only a sentence
or two — do not pad it out. Omit anything that does not change the next move.

Respond with text only. Do not call any tools — you already have everything you
need in the conversation history.

${custom_instruction_block}
