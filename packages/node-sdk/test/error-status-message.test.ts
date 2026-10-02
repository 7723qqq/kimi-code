import { describe, expect, it } from 'vitest';

import { APIStatusError } from '@moonshot-ai/kosong';

import { toKimiErrorPayload } from '#/error-protocol';

describe('toKimiErrorPayload on a provider status error', () => {
  it('prefers the HTML title over the raw body', () => {
    // The shape an nginx or gateway returns: a status line followed by an HTML
    // error page. The title is what a user can act on.
    const payload = toKimiErrorPayload(
      new APIStatusError(
        413,
        '413 <html><head><title>413 Request Entity Too Large</title></head><body>nginx</body></html>',
      ),
    );
    expect(payload.message).toBe('413 Request Entity Too Large');
  });

  it('matches the closing tag case-insensitively', () => {
    const payload = toKimiErrorPayload(
      new APIStatusError(500, '<HTML><TITLE>Bad Gateway</TITLE></HTML>'),
    );
    expect(payload.message).toBe('Bad Gateway');
  });

  it('keeps the raw message when there is no title, or no closing tag', () => {
    for (const message of [
      'plain failure text',
      '<html><body>no title here</body></html>',
      // An unclosed title is left whole rather than swallowing the rest.
      '<html><head><title>truncated forever',
    ]) {
      expect(toKimiErrorPayload(new APIStatusError(500, message)).message).toBe(message);
    }
  });

  it('strips carriage returns so a line cannot be overwritten in a terminal', () => {
    const payload = toKimiErrorPayload(
      new APIStatusError(500, '<title>one\r\ntwo</title>'),
    );
    expect(payload.message).toBe('one\ntwo');
  });

  it('extracts the title from a large body in linear time', () => {
    // The form this replaced (`/<title[^>]*>([\s\S]*?)<\/title>/i`) is quadratic
    // on a body with *many* opening tags and no closing one: the lazy span
    // re-scans the whole tail from each of them. Measured on the old form,
    // 40k opening tags cost seconds; the single-tag case is fast either way, so
    // the shape is the point — the body also arrives over the network.
    const manyOpenTags = '<title>x'.repeat(40_000);
    const started = process.hrtime.bigint();
    const payload = toKimiErrorPayload(new APIStatusError(500, manyOpenTags));
    const manyOpenTagsMs = Number(process.hrtime.bigint() - started) / 1e6;

    // One opening tag, a large tail, no closing tag: linear before and after,
    // and the message comes back whole.
    const oneOpenTag = `<title>too large${'x'.repeat(2_000_000)}`;
    const payload2 = toKimiErrorPayload(new APIStatusError(500, oneOpenTag));

    expect(payload.message).toBe(manyOpenTags);
    expect(payload2.message).toBe(oneOpenTag);
    expect(manyOpenTagsMs).toBeLessThan(1_000);
  });
});
