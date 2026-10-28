import { describe, expect, it } from 'vitest';
import { buildXlsx } from '../../test/buildXlsx';
import { readFirstSheet } from '../xlsx/xlsx';
import { catalogFileLines, linesToQty, parseDraft, qtyToLines } from './draft';
import { parseCatalog } from './parseCatalog';

const HEADER = ['MODEL', 'PRICE', 'COLOR', 'SIZE', 'NOTES', '2Y', '4Y', '6Y'];

async function catalogOf(rows: (string | number | null)[][]) {
  return parseCatalog(await readFirstSheet(await buildXlsx(rows)));
}

describe('draft', () => {
  it('keeps item ids stable when rows move or prices change', async () => {
    const before = await catalogOf([HEADER, ['Dress A', 100, 'Red', '', '', '', '', ''], ['Shirt', 50, 'White']]);
    const after = await catalogOf([
      ['Autumn order'],
      HEADER,
      ['New item', 10, 'Green'],
      ['Shirt', 55, 'White'],
      ['Dress A', 120, 'Red'],
    ]);
    const shirtBefore = before.items.find((i) => i.model === 'Shirt')!;
    const shirtAfter = after.items.find((i) => i.model === 'Shirt')!;
    expect(shirtAfter.id).toBe(shirtBefore.id);
    expect(shirtAfter.row).not.toBe(shirtBefore.row);
  });

  it('gives repeated model + color rows unique ids', async () => {
    // Not adjacent — a repeated row right below is read as a signature row.
    const c = await catalogOf([HEADER, ['Shirt', 1, 'White'], ['Hat', 5, 'Black'], ['Shirt', 2, 'White']]);
    expect(c.items).toHaveLength(3);
    expect(new Set(c.items.map((i) => i.id)).size).toBe(3);
  });

  it('round-trips quantities and reports lines missing from the new catalog', async () => {
    const old = await catalogOf([HEADER, ['Dress A', 100, 'Red'], ['Shirt', 50, 'White'], ['Hat', 5, 'Black']]);
    const [dress, shirt, hat] = old.items;
    const lines = qtyToLines(old, { [dress.id]: { '2Y': 2 }, [shirt.id]: { '6Y': 1 }, [hat.id]: { '4Y': 3 } });

    const next = await catalogOf([['MODEL', 'PRICE', 'COLOR', '2Y', '4Y'], ['Shirt', 50, 'White'], ['Dress A', 90, 'Red']]);
    const { qty, missing } = linesToQty(next, lines);
    expect(qty).toEqual({ [dress.id]: { '2Y': 2 } });
    expect(missing.map((l) => [l.model, l.size, l.qty])).toEqual([
      ['Shirt', '6Y', 1], // size column removed
      ['Hat', '4Y', 3], // model removed
    ]);
  });

  it('reads quantities typed into an order file', async () => {
    const c = await catalogOf([HEADER, ['Dress A', 100, 'Red', '', '', 1, '', 2], ['Shirt', 50, 'White']]);
    expect(catalogFileLines(c).map((l) => [l.model, l.size, l.qty])).toEqual([
      ['Dress A', '2Y', 1],
      ['Dress A', '6Y', 2],
    ]);
  });

  it('rejects malformed drafts and drops invalid lines', () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft('not json')).toBeNull();
    expect(parseDraft('{"lines":[]}')).toBeNull();
    const d = parseDraft(
      JSON.stringify({
        updatedAt: '2026-10-12T10:00:00.000Z',
        lines: [
          { id: 'a|b', model: 'A', color: 'B', size: 'S', qty: 2.7 },
          { id: 'a|b', size: 'M', qty: -1 },
          { id: 5, size: 'L', qty: 1 },
          null,
        ],
      }),
    );
    expect(d).toEqual({
      updatedAt: '2026-10-12T10:00:00.000Z',
      lines: [{ id: 'a|b', model: 'A', color: 'B', size: 'S', qty: 2 }],
    });
  });
});
