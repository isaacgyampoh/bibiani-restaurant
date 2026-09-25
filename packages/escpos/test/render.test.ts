import { describe, expect, it } from 'vitest';
import { CMD, render, toPrintable, wrap } from '../src';

const ascii = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

describe('ESC/POS rendering', () => {
  const doc = {
    schema: 1 as const,
    title: 'Grill #5001',
    blocks: [
      {
        type: 'text' as const,
        text: 'ORDER #5001',
        align: 'center' as const,
        size: 'large' as const,
        bold: true,
      },
      { type: 'columns' as const, left: '15:42', right: 'ROUND 2' },
      { type: 'divider' as const },
      { type: 'text' as const, text: '2 x GRILLED CHICKEN' },
      { type: 'cut' as const },
    ],
  };

  it('starts with init, contains the text and ends with a cut', () => {
    const bytes = render(doc, { paperWidthMm: 80 });
    expect([...bytes.slice(0, 2)]).toEqual([...CMD.init]);
    expect([...bytes.slice(-4)]).toEqual([...CMD.cut]);
    const text = ascii(bytes);
    expect(text).toContain('ORDER #5001');
    expect(text).toContain('2 x GRILLED CHICKEN');
    expect(text).toContain(`15:42${' '.repeat(48 - 5 - 7)}ROUND 2`);
    expect(text).toContain('-'.repeat(48));
  });

  it('uses 32 columns on 58mm paper', () => {
    expect(ascii(render(doc, { paperWidthMm: 58 }))).toContain('-'.repeat(32));
    expect(ascii(render(doc, { paperWidthMm: 58 }))).not.toContain('-'.repeat(33));
  });

  it('prints duplicate and reprint banners before the content', () => {
    const text = ascii(render(doc, { paperWidthMm: 80, possibleDuplicate: true, isReprint: true }));
    expect(text.indexOf('** POSSIBLE DUPLICATE **')).toBeLessThan(text.indexOf('ORDER #5001'));
    expect(text).toContain('** REPRINT **');
  });

  it('only emits printable ASCII for text', () => {
    expect(toPrintable('Kwàme — GH₵ 5')).toBe('Kwame - GHGHS  5');
    expect(wrap('aaaa bbbb cccc', 9)).toEqual(['aaaa bbbb', 'cccc']);
    expect(wrap('x'.repeat(12), 5)).toEqual(['xxxxx', 'xxxxx', 'xx']);
  });
});
