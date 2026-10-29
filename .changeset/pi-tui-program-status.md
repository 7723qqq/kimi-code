---
"@moonshot-ai/pi-tui": minor
---

Report program status over OSC 7501: the terminal queries support once per start behind a device-attributes sentinel, keeps the last status per record and replays it when support is confirmed, clears the status on stop and on exit, and can be forced on or off with `PI_PROGRAM_STATUS`.
