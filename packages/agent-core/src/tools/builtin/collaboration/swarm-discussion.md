Start a roundtable discussion among multiple AI agents. Each agent takes turns speaking, sees the full discussion transcript, and responds naturally — like humans in a roundtable conversation.

Use this when you need multiple perspectives on a complex topic, want agents to critique each other's ideas, or need a synthesized outcome from diverse expertise.

## Input

- `topic`: The topic or question to discuss.
- `participants`: Array of participant configurations. Each participant has:
  - `profileName`: Agent profile (e.g. "coder", "explore"). Defaults to "coder".
  - `roleDescription`: The role this agent plays (e.g. "You are a senior database architect...").
  - `turnsPerRound`: How many times this participant speaks per round (default: 1).
- `maxRounds`: Maximum number of full rounds (default: 3). Each round = every participant speaks once.
- `summaryPrompt`: Optional. If provided, a summary is generated after the discussion ends.

## Example

```json
{
  "topic": "How should we optimize our database for high concurrency?",
  "participants": [
    {
      "profileName": "coder",
      "roleDescription": "You are a database researcher who specializes in connection pooling and query optimization."
    },
    {
      "profileName": "coder",
      "roleDescription": "You are a systems architect who focuses on scalability and distributed systems."
    }
  ],
  "maxRounds": 3,
  "summaryPrompt": "Summarize the key decisions and action items from this discussion."
}
```

## Behavior

- Each participant receives the full discussion transcript before their turn.
- Participants speak naturally — no special tools or communication primitives needed.
- The discussion ends after `maxRounds` rounds.
- Results include the full transcript, summary, and aggregate token usage.