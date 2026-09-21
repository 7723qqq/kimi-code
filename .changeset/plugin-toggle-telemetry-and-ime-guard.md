---
'@moonshot-ai/kimi-code': patch
---

Plugin toggles now report a `plugin_toggle` telemetry event carrying the resulting enabled-plugin set, and turn telemetry carries the same set when the host provides it. The VS Code question dialog no longer submits an unfinished custom answer when Enter is pressed to confirm IME input.
