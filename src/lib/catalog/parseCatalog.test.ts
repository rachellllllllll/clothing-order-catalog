import { describe, expect, it } from 'vitest';
import { buildXlsx } from '../../test/buildXlsx';
import { readFirstSheet } from '../xlsx/xlsx';
import { buildOrderUpdates, exportFileName } from './exportOrder';
import { parseCatalog } from './parseCatalog';
import { cartLines, cartTotals } from './selectors';
import type { QtyMap } from './types';

const ROWS = [
  ['Spring order'],
  ['MODEL', 'PRICE', 'COLOR', 'SIZE', 'NOTES', '2Y', '4Y', '6Y'],
  ['Dress A', 100, 'Red', '2Y-4Y', '', 1, '', ''],
  ['Dress A', '', 'Red', '', '', 'Dana', '', ''],
  ['Dress A', 100, 'Blue', '', 'new', '', 2, ''],
  ['Shirt', '', 'White', '', '', '', '', 3],
];

async function catalog() {
  return parseCatalog(await readFirstSheet(await buildXlsx(ROWS)));
}

describe('parseCatalog', () => {
  it('finds header, columns, groups and signature rows', async () => {
    const c = await catalog();
    expect(c.sheetName).toBe('Order');
    expect(c.columns.sizeCols.map((s) => s.label)).toEqual(['2Y', '4Y', '6Y']);
    expect(c.items).toHaveLength(3);
    expect(c.groups.map((g) => [g.model, g.variants.length])).toEqual([
      ['Dress A', 2],
      ['Shirt', 1],
    ]);

    const [red, blue, shirt] = c.items;
    expect(red.signatureRow).toBe(4);
    expect(red.signature).toBe('Dana');
    expect(red.initialQty).toEqual({ '2Y': 1, '4Y': 0, '6Y': 0 });
    expect([...red.availableSizes!]).toEqual(['2Y', '4Y']);
    expect(blue.row).toBe(5);
    expect(blue.notes).toBe('new');
    expect(blue.signatureRow).toBeNull();
    expect(shirt.price).toBeNull();
  });

  it('builds cart lines, totals and export updates', async () => {
    const c = await catalog();
    const [red, , shirt] = c.items;
    const qty: QtyMap = { [red.id]: { '2Y': 2 }, [shirt.id]: { '6Y': 1 } };

    const lines = cartLines(c, qty);
    expect(cartTotals(lines)).toEqual({ units: 3, amount: 200, unpricedUnits: 1 });

    const updates = buildOrderUpdates(c, qty, 'Noa');
    expect(updates).toContainEqual({ row: 3, col: 6, value: 2 });
    expect(updates).toContainEqual({ row: 3, col: 7, value: '' });
    expect(updates).toContainEqual({ row: 4, col: 6, value: 'Noa' });
    expect(updates).toContainEqual({ row: 6, col: 8, value: 1 });
  });

  it('names the exported file', () => {
    expect(exportFileName('Spring 2025.xlsx', 'Noa', new Date(2025, 2, 7))).toBe(
      'Spring 2025_ORDERED_Noa_2025-03-07.xlsx',
    );
  });
});
