---
"@moonshot-ai/kaos": patch
---

`SSHKaos.readLines()` now uses the same line definition as `LocalKaos`: terminators are kept on each line, only LF splits, and a lone CR is content rather than a line break, so the two implementations return byte-identical line sequences for the same file. Breaking for consumers that relied on the old remote behaviour, where lines came back stripped of their terminator and split on CRLF or a lone CR.
