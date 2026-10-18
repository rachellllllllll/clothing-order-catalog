import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildXlsx } from '../../test/buildXlsx';
import { colToLetters, lettersToCol, patchFirstSheet, readFirstSheet } from './xlsx';

const toArrayBuffer = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

describe('xlsx', () => {
  it('converts column letters', () => {
    for (const [n, s] of [
      [1, 'A'],
      [26, 'Z'],
      [27, 'AA'],
      [703, 'AAA'],
    ] as const) {
      expect(colToLetters(n)).toBe(s);
      expect(lettersToCol(s)).toBe(n);
    }
  });

  it('reads shared strings and numbers', async () => {
    const grid = await readFirstSheet(await buildXlsx([['MODEL', 'PRICE'], ['A & B', 12.5]]));
    expect(grid.maxRow).toBe(2);
    expect(grid.maxCol).toBe(2);
    expect(grid.get(2, 1)).toBe('A & B');
    expect(grid.get(2, 2)).toBe(12.5);
    expect(grid.get(5, 5)).toBe('');
  });

  it('patches existing and new cells while keeping style and order', async () => {
    const original = await buildXlsx([
      ['MODEL', 'QTY'],
      ['A', 5],
    ]);
    const patched = await patchFirstSheet(original, [
      { row: 2, col: 2, value: '' },
      { row: 2, col: 4, value: 7 },
      { row: 2, col: 3, value: 'Dana' },
      { row: 4, col: 1, value: 'new row' },
    ]);

    const grid = await readFirstSheet(toArrayBuffer(patched));
    expect(grid.get(2, 2)).toBe('');
    expect(grid.get(2, 3)).toBe('Dana');
    expect(grid.get(2, 4)).toBe(7);
    expect(grid.get(4, 1)).toBe('new row');

    const xml = await (await JSZip.loadAsync(patched)).file('xl/worksheets/sheet1.xml')!.async('text');
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<c r="B2" s="1"/>'); // cleared cell keeps its style
    expect(xml.indexOf('r="C2"')).toBeLessThan(xml.indexOf('r="D2"'));
    expect(xml).not.toMatch(/<row r="2"[^>]*spans/);
  });
});
