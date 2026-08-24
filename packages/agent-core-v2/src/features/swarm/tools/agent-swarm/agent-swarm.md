Launch multiple subagents from one prompt template, existing agent resumes, or both.

Use AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly `{{item}}`. For example, with `prompt_template` set to `Review {{item}} for likely regressions.` and `items` set to `["src/a.ts", "src/b.ts"]`, AgentSwarm launches two new subagents with those two concrete prompts. For a few differently-shaped tasks, make separate `Agent` calls in one message instead.

Use `resume_agent_ids` to continue subagents that already exist from earlier work, such as ones that failed or timed out. Pass a flat object: keys are existing `agent_id` strings (as reported in a previous swarm's `<subagent agent_id="...">` output), values are the continuation prompt for that subagent (usually `"continue"` if no extra information is needed). For example, with `resume_agent_ids` set to `{"agent-coder-1": "continue", "agent-coder-2": "focus on the imports"}`, AgentSwarm resumes those two existing subagents and spawns no new ones. You may combine `resume_agent_ids` with `items` to resume some and spawn others; resumed agents always run before fresh spawns and keep their original `subagent_type` and model. `resume_agent_ids` is a flat record — do not pass an array or a list of `{item, prompt}` objects, and do not use `{{item}}` as a key: that placeholder only applies to `prompt_template`.

Each of these is enforced — a violation is rejected before any subagent starts: provide at least 2 `items` unless you pass `resume_agent_ids`; whenever `items` are present, `prompt_template` is required and must contain `{{item}}`; and the filled-in prompts must be distinct (two items that expand to the same prompt are rejected).

Use enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.

If `AgentSwarm` is called, that call must be the only tool call in the response.
