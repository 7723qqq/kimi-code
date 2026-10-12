---
"@moonshot-ai/kimi-code": patch
---

Remote Control pages opened through the tunnel now set the session's device prefix again on a non-loopback server. The prefix fix was injected as an inline script, which the server's own Content-Security-Policy forbids, so it never ran; it is loaded from a same-origin script now.
