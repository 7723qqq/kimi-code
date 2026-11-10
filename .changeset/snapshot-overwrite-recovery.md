---
"@moonshot-ai/kimi-code": minor
---

Add recovery snapshots for overwritten files and a SnapshotList tool. Run kimi snapshot list <path> to inspect versions and kimi snapshot restore <path> --previous (or --hash <sha|id>) to restore them; agent marks and retention are available through kimi snapshot agents and kimi snapshot prune.
