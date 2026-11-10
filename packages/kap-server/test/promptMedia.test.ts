import { describe, expect, it } from 'bun:test';

import { contentToCoreParts } from '../src/lib/promptMedia';

type Wire = Parameters<typeof contentToCoreParts>[0];

describe('contentToCoreParts: documents', () => {
  it('maps a wire file part to a document_url part', () => {
    const parts = contentToCoreParts([
      { type: 'text', text: 'read this' },
      { type: 'file', file_id: 'file-d1', name: 'report.pdf', media_type: 'application/pdf' },
    ] as unknown as Wire);

    expect(parts).toEqual([
      { type: 'text', text: 'read this' },
      {
        type: 'document_url',
        documentUrl: {
          url: 'kimi-file://file-d1',
          mimeType: 'application/pdf',
          id: 'file-d1',
          name: 'report.pdf',
        },
      },
    ]);
  });

  it('defaults the mime type to application/pdf when the wire omits it', () => {
    const parts = contentToCoreParts([
      { type: 'file', path: '/tmp/report.pdf' },
    ] as unknown as Wire);

    expect(parts).toEqual([
      {
        type: 'document_url',
        documentUrl: { url: '/tmp/report.pdf', mimeType: 'application/pdf' },
      },
    ]);
  });
});
