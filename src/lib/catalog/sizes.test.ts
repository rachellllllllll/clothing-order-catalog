import { describe, expect, it } from 'vitest';
import { computeAvailableSizes, isSizeHeader, parseSizeRange, sizeToMonths } from './sizes';

describe('sizes', () => {
  it('recognizes size headers', () => {
    for (const h of ['XS', 'xl', '3M', '24m', '2Y', '16y', '10', 'X.L']) expect(isSizeHeader(h)).toBe(true);
    for (const h of ['MODEL', 'price', 'color', '']) expect(isSizeHeader(h)).toBe(false);
  });

  it('orders month sizes just below the equal year size', () => {
    expect(sizeToMonths('24M')!).toBeLessThan(sizeToMonths('2Y')!);
    expect(sizeToMonths('10')).toBe(120);
    expect(sizeToMonths('L')).toBeNull();
  });

  it('parses ranges in any order and dash style', () => {
    expect(parseSizeRange('2Y-16Y')).toEqual({ lo: 24, hi: 192 });
    expect(parseSizeRange('16Y – 2Y')).toEqual({ lo: 24, hi: 192 });
    expect(parseSizeRange('M')).toBeNull();
  });

  it('computes available sizes from a range', () => {
    const cols = ['18M', '24M', '2Y', '4Y', '16Y', 'XL'].map((label, i) => ({ col: i + 1, label }));
    const set = computeAvailableSizes('2Y-4Y', cols)!;
    expect([...set]).toEqual(['2Y', '4Y', 'XL']);
    expect(computeAvailableSizes('', cols)).toBeNull();
  });
});
