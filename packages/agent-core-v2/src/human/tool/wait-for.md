Wait for background tasks to finish without ending the current turn.

Use only when the next step genuinely cannot proceed without a running task's result; otherwise continue other work and rely on automatic completion notifications. The call suspends the turn until a task finishes or `timeout` elapses, without making LLM requests while waiting.

- `timeout` is required, in seconds, capped at 600. To wait longer, call WaitFor again; waking up periodically also lets you re-evaluate the situation.
- A timeout is not an error: the result lists the tasks that are still running, so you decide whether to wait again or do other work.
- Without `task_id` the wait ends when any task running at call time finishes; with `task_id` it ends when that task finishes, and an unknown ID is an error.
- The result lists completed and running tasks. Waiting never stops tasks, and user interruption leaves them running. Only tasks started by this agent can be waited on.
- WaitFor reaps completed background tasks; completion notifications may still be delivered by the runtime.
