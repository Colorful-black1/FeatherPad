import { describe, expect, it } from 'vitest';
import { safePreviewUrl } from './links';

describe('preview URI policy', () => {
  it('keeps relative Chinese, spaces, percent and filename fragments with a single decode', () => {
    expect(safePreviewUrl('图%20片/100%25%23.png#查看', 'image')).toMatchObject({
      kind: 'local', path: '图 片/100%#.png', fragment: '查看', url: '图%20片/100%25%23.png#查看',
    });
    expect(safePreviewUrl('#%E7%AB%A0%E8%8A%82', 'link')).toEqual({ kind: 'anchor', fragment: '章节' });
    expect(safePreviewUrl('../图.png', 'image')).toMatchObject({ kind: 'local', path: '../图.png' });
  });

  it('blocks scripts, entity/percent encoded protocols, network/device/ADS and repeated path decoding', () => {
    for (const value of ['javascript:alert(1)', 'javas&#99;ript&colon;alert(1)', 'javascript%3Aalert(1)',
      'java\nscript:alert(1)', 'vbscript:x', 'shell:calc', 'file:///C:/secret', '//server/share',
      '\\\\server\\share', '%5c%5cserver/share', 'C:\\secret', 'image.png:secret', '%252e%252e/secret',
      'data:text/html;base64,PHNjcmlwdD4=', 'https://user:secret@example.com/', 'image%00.png']) {
      expect(safePreviewUrl(value, 'image').kind, value).toBe('blocked');
    }
  });

  it('classifies remote links for explicit user action and data images for native size/MIME verification', () => {
    expect(safePreviewUrl('https://example.com/中文', 'link')).toEqual({ kind: 'external', url: 'https://example.com/%E4%B8%AD%E6%96%87' });
    expect(safePreviewUrl('mailto:author@example.com', 'link').kind).toBe('external');
    expect(safePreviewUrl('data:image/png;base64,aGVsbG8=', 'image').kind).toBe('data-image');
    expect(safePreviewUrl('data:image/png;base64,aGVsbG8=', 'link').kind).toBe('blocked');
  });
});
