import { describe, expect, it } from 'vitest';
import type { OrderDto, OrderLine } from '../../../api/_types';
import { buildXlsx } from '../../test/buildXlsx';
import { patchFirstSheet, readFirstSheet } from '../xlsx/xlsx';
import { combineOrders } from './combinedOrder';
import { parseCatalog } from './parseCatalog';

const HEADER = ['MODEL', 'PRICE', 'COLOR', 'SIZE', 'NOTES', 'S', 'M'];

function order(name: string, lines: OrderLine[], submitted: OrderLine[] | null): OrderDto {
  const at = '2026-01-01T00:00:00.000Z';
  return { name, rev: 1, createdAt: at, updatedAt: at, lines, submitted: submitted && { at, rev: 1, lines: submitted } };
}

describe('combineOrders', () => {
  it('sums sent orders into the sheet with names on signature rows', async () => {
    const xlsx = await buildXlsx([HEADER, ['Dress', 10, 'Red'], ['Dress', null, 'Red'], ['Shirt', 5, 'White']]);
    const catalog = parseCatalog(await readFirstSheet(xlsx));
    const [dress, shirt] = catalog.items;
    expect(dress.signatureRow).toBe(3);
    const l = (id: string, size: string, qty: number) => ({ id, model: '', color: '', size, qty });

    const orders = [
      order('Rina', [l(dress.id, 'S', 9)], [l(dress.id, 'S', 2), l(shirt.id, 'M', 1)]),
      order('Dana', [l(dress.id, 'S', 1)], [l(dress.id, 'S', 3), l('gone|item', 'S', 4), l(shirt.id, 'XL', 1)]),
      order('Noa', [l(shirt.id, 'S', 1)], null),
    ];

    const sent = combineOrders(catalog, orders, 'submitted');
    expect(sent.included).toEqual([
      { name: 'Dana', units: 8 },
      { name: 'Rina', units: 3 },
    ]);
    expect(sent.skipped).toEqual(['Noa']);
    expect(sent.missing.map((m) => [m.name, m.line.id, m.line.size])).toEqual([
      ['Dana', 'gone|item', 'S'],
      ['Dana', shirt.id, 'XL'],
    ]);
    expect(sent.units).toBe(6);

    const bytes = await patchFirstSheet(xlsx, sent.updates);
    const grid = await readFirstSheet(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(grid.get(2, 6)).toBe(5);
    expect(grid.get(3, 6)).toBe('Dana 3, Rina 2');
    expect(grid.get(4, 7)).toBe(1);
    expect(grid.get(2, 7)).toBe('');

    const current = combineOrders(catalog, orders, 'current');
    expect(current.units).toBe(11);
    expect(current.skipped).toEqual([]);
  });
});
