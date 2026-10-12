---
'@moonshot-ai/agent-core-v2': minor
'@moonshot-ai/kosong': minor
'@moonshot-ai/kimi-code-sdk': minor
'@moonshot-ai/kimi-code': minor
'@moonshot-ai/kap-server': patch
---

Send attached PDFs to the model instead of telling it to read a file it cannot open

A PDF attachment was materialized on disk and the model was handed a path with
"open it with the Read tool" — and Read answered `"report.pdf" is not readable
as UTF-8 text`, every time. Nothing in the pipeline could carry a document: the
message union had no document part, no protocol adapter encoded one, the media
router did not classify `application/pdf`, and `capabilities` had no `pdf_in` to
gate it on.

The document channel now exists end to end:

- `ContentPart` gains `document_url` (`documentUrl: { url, mimeType, name? }`),
  and the engine, SDK and kosong copies of the union stay in step.
- Every protocol that can carry a document encodes it: Anthropic `document`
  blocks (base64 or url source), OpenAI Chat `file` with `file_data`,
  OpenAI Responses `input_file`, and google-genai `inlineData`. Each adapter
  handles both a regular message and a tool result — a tool that returns a PDF
  used to drop it silently, which is fixed too.
- `mediaKindForMime` reports `application/pdf` as `document` instead of
  `undefined`, `file-type.ts` classifies `.pdf` and sniffs the `%PDF-` header,
  and `.pdf` leaves `NON_TEXT_SUFFIXES` so Read routes it to the media path.
- `executeMediaRead` builds the `document_url` part and gates on `pdf_in`,
  degrading exactly like image and video: an unknown capability still attempts
  the read, and the model is told which capability is missing otherwise.

`pdf_in` joins both capability twins, `isUnknownCapability`, `toLlmCapability`
and every place a declared capability string becomes a boolean. The
`isUnknownCapability` chain needs `pdf_in` as much as the `declared.has('pdf_in')`
checks do: without it a model declaring *only* `pdf_in` reads as "capability
unknown" and bypasses the very gate that was added for it.

The attachment notice now says "call the Read tool on this path to send the PDF
to the model" for a PDF, which is what actually happens; other media types keep
their previous wording.
