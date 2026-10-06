---
"@moonshot-ai/kimi-code": patch
---

Stop tower mode from taking the process down when leaving it fails. A rejected tower exit (releasing workspace ownership while another session holds the tower) surfaced as an unhandled rejection and, on Bun and Node's default settings, terminated the process outright. Failed exits and failed roster bookkeeping are now reported through the log instead.
