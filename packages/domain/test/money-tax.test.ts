import { describe, expect, it } from 'vitest';
import { assertMinor, calculateLineTaxes, formatMinor, percentOf, roundHalfAwayFromZero } from '../src';

describe('money', () => {
  it('rounds half away from zero', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(2.4999)).toBe(2);
    expect(percentOf(1005, 1500)).toBe(151); // 150.75 -> 151
  });
  it('rejects non-integer minor units', () => {
    expect(() => assertMinor(10.5)).toThrow();
    expect(assertMinor(1050)).toBe(1050);
  });
  it('formats for receipts', () => {
    expect(formatMinor(1234567, 'GHS')).toBe('GHS 12,345.67');
    expect(formatMinor(-5, 'GHS')).toBe('-GHS 0.05');
  });
});

describe('taxes', () => {
  const rate = (id: string, bp: number, inclusive: boolean, compound = false, order = 0) => ({
    id,
    name: id,
    rateBp: bp,
    isInclusive: inclusive,
    isCompound: compound,
    applyOrder: order,
  });

  it('extracts inclusive tax from the gross price', () => {
    const r = calculateLineTaxes(11500, [rate('vat', 1500, true)]);
    expect(r.inclusiveTotal).toBe(1500);
    expect(r.exclusiveTotal).toBe(0);
  });

  it('splits several inclusive taxes so the parts always sum to the extracted total', () => {
    for (const gross of [100, 999, 12345, 26000, 1]) {
      const r = calculateLineTaxes(gross, [
        rate('a', 1500, true),
        rate('b', 250, true),
        rate('c', 250, true),
      ]);
      expect(r.lines.reduce((acc, l) => acc + l.amount, 0)).toBe(r.inclusiveTotal);
    }
  });

  it('applies exclusive and compound taxes in order', () => {
    const r = calculateLineTaxes(10000, [
      rate('levy', 500, false, false, 1),
      rate('vat', 1500, false, true, 2),
    ]);
    expect(r.lines.map((l) => l.amount)).toEqual([500, 1575]); // vat on 10000 + 500
    expect(r.exclusiveTotal).toBe(2075);
  });

  it('refuses inclusive compound taxes', () => {
    expect(() => calculateLineTaxes(100, [rate('x', 100, true, true)])).toThrow(/compound/);
  });
});
