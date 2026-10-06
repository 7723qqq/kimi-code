Use this tool when you are in spec mode and have finished writing the spec documents, and are ready for the user to review them.

## How This Tool Works
- The requirements, design and tasks documents are read from the spec directory, not passed as parameters.
- The user sees all three when they review. In auto permission mode the tool exits spec mode without asking.
- All three must be non-empty. A missing or empty document is rejected, naming the file you still have to write.

## When to Use
Use it only when the spec is genuinely ready to be approved. It does not verify the quality of what you wrote — it checks that the three documents exist and hands them to the user.

## What a good spec contains
- **Requirements**: the goal, who it is for, the boundaries, and what is explicitly out of scope. A requirement the user did not imply is a defect.
- **Design**: the concrete approach — real files, functions and contracts — plus the trade-offs you rejected and why.
- **Tasks**: work split small enough to finish and to check, each with acceptance criteria. "Handles errors" is not a criterion; "returns 409 when the email already exists" is.

## Multiple Approaches
If the design document leaves a genuine choice between approaches, pass them via the `options` parameter so the user can pick which one to execute. Each option must correspond to an approach the design document actually describes.

## After Approval
Spec mode ends and normal tool permissions return. Work through the tasks document, and record progress in the spec's progress file as you go. The progress file is a working note for whoever reads the spec next; it is not gated by this tool.
