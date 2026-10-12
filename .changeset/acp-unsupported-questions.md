---
"@moonshot-ai/kimi-code": patch
---

Tell the model when the connected editor cannot show interactive questions, instead of reporting the question as dismissed by the user. Previously an editor without a question surface made the model believe the user declined and carry on; the tool now answers that questions are unsupported and asks the model to put the question in its reply instead.
