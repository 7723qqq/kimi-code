Fetch content from a URL. Supports HTML pages (main article extraction), JSON responses (pretty-printed), plain text/markdown, and text-based PDFs. A note at the top of the result states whether you received the full response body or extracted text.

Optional parameters help with large pages:
- `query`: extract only the highest-ranked passages matching your question instead of reading a whole long document.
- `maxChars`: limit output character count.
- `bypassCache`: ignore cached content and re-fetch from origin.

Only fully-formed public `http`/`https` URLs are supported; other schemes are rejected. The fetch carries no login or session for the target site, so pages behind authentication return a login page or an error instead of the real content — if the text you get back looks like a sign-in page, reach the content through an authenticated CLI or MCP tool instead.
