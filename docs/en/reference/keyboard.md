# Keyboard Shortcuts

Kimi Code CLI's TUI interactive mode supports a set of keyboard shortcuts. The shortcuts are organized into seven groups by usage context: general input, mode switching, input and editing, during streaming, tool output control, the approval panel, and popup navigation. Type `/help` in the TUI at any time to open the built-in shortcut reference.

## General Shortcuts

The following keys are always available in the input box:

| Shortcut | Function |
| --- | --- |
| `Enter` | Submit the current input |
| `Shift-Enter` / `Ctrl-J` | Insert a newline in the input |
| `↑` / `↓` | Browse input history |
| `Esc` | Close a popup / cancel completion / interrupt streaming output or context compaction |
| `Ctrl-C` | Interrupt the current streaming output, or clear the input box |
| `Ctrl-D` | Exit Kimi Code CLI when the input box is empty |
| `Ctrl-T` | Expand or collapse the experimental `Updates` panel, when folding it would show or hide something |
| `Ctrl-P` | Rewrite the drafted prompt with AI |
| `Ctrl-N` | Focus or release the experimental `Updates` panel |

While the `Updates` panel is focused: `←` / `→` switch agent channels, `↑` / `↓` scroll the current update, `[` / `]` step between that channel's updates (`PgUp` / `PgDn` also step, outside fullscreen where those keys page the transcript), and `Esc` releases focus. The updates area lives in the strip above the input box, alongside the activity pane. Its header row reports the current page and how many rows are out of view. The strip never takes more than half the terminal height (up to 20 rows). Agents that have finished collapse into a single `+N done` tab; the agent you are viewing always keeps its own tab, and folded entries stay reachable with `←` / `→`. Each new update opens at its **top** and the area reads it downward on its own, so a long update is read in the order it was written; the walk stops at the end, and scrolling by hand takes over. The mouse works too, without taking the keyboard: the wheel over the updates area scrolls the current update (it no longer falls through to the transcript, and does not grab focus — `Ctrl-N` is still what takes focus), and it takes effect immediately rather than after a priming click. Clicking a channel tab switches to that agent; clicking `+N done` expands the folded agents into their own tabs, and the tab then reads `−N done` so the same spot folds them back. Clicking anywhere else on the updates area folds or unfolds it, exactly like clicking a folded tool card in the transcript — it does not take the keyboard. Scrolling up stops the view from following new updates until you scroll back to the bottom.

Pressing `Ctrl-C` **during streaming** cancels immediately — no second confirmation needed.

**Exiting the program** (pressing `Ctrl-C` with an empty input box, or pressing `Ctrl-D`) uses a double-press confirmation mechanism: after the first press, a prompt appears in the status bar; a second press of the same key actually exits. Pressing any other key in between clears the confirmation state.

## Mode Switching

| Shortcut | Function |
| --- | --- |
| `Shift-Tab` | Cycle review modes (Plan → Spec → off) |
| `!` | Enter shell mode (in an empty input box) |

Press `Shift-Tab` to cycle through the review modes: Plan, then Spec, then off. In Plan mode, the Agent prioritizes read-only tools for research and planning and can write to the current plan file; `Bash` is subject to the current permission mode and regular rules, without any additional separate approval triggered by Plan mode. Simply toggling does not create an empty plan file. See [Slash Commands](./slash-commands.md#modes--run-control) for the full mode model.

Type `!` in an empty input box to enter shell mode and run terminal commands directly; while a command is running, press `Ctrl+B` to move it to a background task. See [Interaction and input](../guides/interaction.md#shell-mode).

## Input & Editing

| Shortcut | Function |
| --- | --- |
| `Ctrl-G` | Edit the current input in an external editor |
| `Ctrl-V` | Paste an image or video from the clipboard (Unix / macOS) |
| `Alt-V` | Paste an image or video from the clipboard (Windows) |
| `Ctrl--` | Undo |
| `Esc` `Esc` | Open the undo selector (double-press while idle) |

Pressing `Ctrl-G` opens an external editor, selected according to the following priority:

1. The editor configured via the `/editor` command
2. The `$VISUAL` environment variable
3. The `$EDITOR` environment variable

After saving and exiting, the edited content replaces the input box; exiting without saving leaves the input unchanged.

When pasting an image or video, a placeholder is shown in the input box — the actual media data is sent to the model when the message is submitted. The system clipboard is read first; on Linux, Wayland and X11 are tried; on WSL, PowerShell is also used as a fallback to read the Windows clipboard.

## During Streaming

While streaming output is active, the input box can still receive input and supports the following additional operations:

| Shortcut | Function |
| --- | --- |
| `Ctrl-S` | Steer: inject the current input directly into the running turn |
| `Esc` | Interrupt the current streaming output |
| `Ctrl-C` | Interrupt the current streaming output |

Pressing `Ctrl-S` causes the model to see your message at the next interruptible point, without waiting for the current turn to finish.

## Tool Output

| Shortcut | Function |
| --- | --- |
| `Ctrl-O` | Expand or collapse tool output, shell command output, and compaction summaries |

When collapsed tool call results or shell command outputs exist in the history, press `Ctrl-O` to toggle between collapsed and expanded views. After compaction, the same shortcut shows or hides the compaction summary in the compaction block.

## Approval Panel

When the Agent initiates a tool call that requires confirmation, the TUI shows an approval prompt that replaces the input box until the request is resolved. In fullscreen the prompt is docked: a long request scrolls in the body while the choices stay on screen. The prompt starts folded to a compact summary that still shows the numbered options — one row per option — so `1` / `2` / `3` and `Enter` work without expanding it. For the full approval workflow, see [Interaction & Input](../guides/interaction.md#approval-flow). The available keys are:

| Shortcut | Function |
| --- | --- |
| `↑` / `↓` | Move the cursor between candidate options |
| `Enter` | Confirm the currently selected option |
| `1` ~ `9` | Directly select the option at the corresponding index |
| `Esc` / `Ctrl-C` / `Ctrl-D` | Reject the current request |
| `Ctrl-E` | Open the full content in a full-screen viewer when the prompt contains a diff or file preview |
| `Ctrl-O` | Toggle the collapsed state of other tool output |

Options that require feedback (such as "Reject" or "Revise") switch to a feedback input state after confirmation: type the feedback text and press `Enter` to submit; press `Esc` to exit feedback input and return to the candidate list.

## Popup Mode

After opening the help panel with `/help`, use the following keys to navigate and close it:

| Shortcut | Function |
| --- | --- |
| `↑` / `↓` | Scroll one line at a time |
| `PageUp` / `PageDown` | Scroll 10 lines at a time |
| `Esc` / `Enter` / `q` / `Q` | Close the panel |

## Next steps

- [Slash Commands](./slash-commands.md) — Quick reference for built-in TUI control commands
- [`kimi` Command](./kimi-command.md) — Complete reference for startup flags and subcommands
