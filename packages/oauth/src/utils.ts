export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const MAX_HTTP_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Read a fetch response body as UTF-8 text, refusing bodies larger than
 * `maxBytes`. The `Content-Length` header is pre-flighted and the stream is
 * read incrementally so an oversized body is cancelled as soon as the cap is
 * exceeded instead of being buffered whole.
 */
export async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Response body too large: ${String(contentLength)} bytes (max ${String(maxBytes)}).`);
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Response body too large: ${String(total)} bytes (max ${String(maxBytes)}).`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString('utf8');
}
