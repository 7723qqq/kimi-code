Set the status of the current goal. `active` resumes a paused or blocked goal when the user explicitly asks you to work on it again.

`complete` submits the goal to the independent judge. It is a completion request, not a self-certification: unless the judge accepts the condition, the goal stays active and the next turn starts with the judge's reason. Call it only when you believe the condition is met and can point to concrete evidence. After it is accepted, write the final summary.

`blocked` ends autonomous work only for a genuine impasse: a required decision only the user can make, missing credentials or permissions, an external condition, or a safety boundary. Do not call it because the work is large, hard, slow, uncertain, or needs more turns.

Never call this tool merely to report progress or to end a slice of work. Do not ask the user whether to continue.
