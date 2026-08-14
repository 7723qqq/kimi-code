Run a TypeScript/JavaScript program in an isolated worker thread and return its console output and completion value.

- The program body runs as an async function: top-level `await` and `return` work (e.g. `return 1 + 2`, `await fetch(...).then(r => r.json())`).
- `console.log` / `console.info` / `console.warn` / `console.error` / `console.debug` output is captured in emission order.
- The completion value must be JSON-serializable (objects, arrays, strings, numbers, booleans, null). `undefined` (e.g. a bare `return`) reports `value: undefined`. Functions, classes, and circular structures fail with an `invalid-output` error.
- No state survives between calls — each run spawns a fresh worker.
- The worker thread is a soft isolation boundary, NOT a security sandbox: treat model-written code with the same trust level as a Bash command.
- Prefer this tool over Bash for pure computation, data transformation, algorithm verification, parsing, and small scripting tasks that do not need shell features.
