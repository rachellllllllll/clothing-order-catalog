import { describe, expect, it } from 'vitest';
import type { OrderDto, OrderLine, OrderSummary } from '../../../api/_types';
import { buildXlsx } from '../../test/buildXlsx';
import { readFirstSheet } from '../xlsx/xlsx';
import { linesTotals, matchesStatus, orderDetail, productsView } from './adminView';
import { parseCatalog } from './parseCatalog';

const HEADER = ['MODEL', 'PRICE', 'COLOR', 'SIZE', 'NOTES', 'S', 'M', 'L'];

function order(name: string, lines: OrderLine[], submitted: OrderLine[] | null): OrderDto {
  const at = '2026-01-01T00:00:00.000Z';
  return { name, rev: 2, createdAt: at, updatedAt: at, lines, submitted: submitted && { at, rev: 1, lines: submitted } };
}

const l = (id: string, size: string, qty: number): OrderLine => ({ id, model: '', color: '', size, qty });

async function catalog() {
  return parseCatalog(await readFirstSheet(await buildXlsx([HEADER, ['Coat', 200, 'Black'], ['Hat', null, 'Red'], ['Shirt', 50, 'White']])));
}

describe('productsView', () => {
  it('sums the chosen version per item and size, with who ordered what', async () => {
    const cat = await catalog();
    const [coat, hat] = cat.items;
    const orders = [
      order('רונית', [l(coat.id, 'M', 5)], [l(coat.id, 'M', 1), l(hat.id, 'S', 2)]),
      order('אבי', [l(coat.id, 'L', 1)], [l(coat.id, 'M', 2), l('gone|item', 'S', 1), l(coat.id, 'XL', 1)]),
      order('דנה', [l(coat.id, 'M', 1)], null),
    ];

    const sent = productsView(cat, orders, 'submitted');
    const coatRow = sent.rows.find((r) => r.item.id === coat.id)!;
    expect(coatRow.qty).toEqual({ M: 3 });
    expect(coatRow.who.M).toEqual([
      { name: 'אבי', qty: 2 },
      { name: 'רונית', qty: 1 },
    ]);
    expect(sent.sizes).toEqual(['S', 'M']);
    expect(sent.sizeTotals).toEqual({ S: 2, M: 3 });
    expect(sent.totals).toEqual({ units: 5, amount: 600, unpricedUnits: 2 });
    expect(sent.missing.map((m) => [m.name, m.line.id, m.line.size])).toEqual([
      ['אבי', 'gone|item', 'S'],
      ['אבי', coat.id, 'XL'],
    ]);

    const current = productsView(cat, orders, 'current');
    expect(current.sizes).toEqual(['M', 'L']);
    expect(current.totals.units).toBe(7);
    expect(current.missing).toEqual([]);
  });
});

describe('orderDetail', () => {
  it('puts both versions side by side in catalog and size order', async () => {
    const cat = await catalog();
    const [coat, hat, shirt] = cat.items;
    const o = order(
      'רונית',
      [l(shirt.id, 'S', 1), l(coat.id, 'L', 3), l(coat.id, 'S', 1), l('gone|item', 'M', 1)],
      [l(coat.id, 'L', 1), l(hat.id, 'M', 2)],
    );
    expect(orderDetail(cat, o).map((r) => [r.model, r.size, r.sent, r.current])).toEqual([
      ['Coat', 'S', 0, 1],
      ['Coat', 'L', 1, 3],
      ['Hat', 'M', 2, 0],
      ['Shirt', 'S', 0, 1],
      ['', 'M', 0, 1],
    ]);
  });
});

describe('linesTotals', () => {
  it('prices lines from the catalog and counts unpriced units apart', async () => {
    const cat = await catalog();
    const [coat, hat] = cat.items;
    expect(linesTotals(cat, [l(coat.id, 'M', 2), l(hat.id, 'S', 1), l('gone|item', 'S', 3)])).toEqual({
      units: 6,
      amount: 400,
      unpricedUnits: 4,
    });
  });
});

describe('matchesStatus', () => {
  const s = (submittedAt: string | null, rev: number, submittedRev: number | null): OrderSummary => ({
    fileId: 'f',
    name: 'n',
    rev,
    units: 1,
    updatedAt: '',
    submittedAt,
    submittedRev,
    hasPin: true,
  });

  it('tells sent, unsent and changed-after-send orders apart', () => {
    const sent = s('2026-01-01', 2, 2);
    const changed = s('2026-01-01', 3, 2);
    const unsent = s(null, 1, null);
    expect([sent, changed, unsent].map((o) => matchesStatus(o, 'sent'))).toEqual([true, true, false]);
    expect([sent, changed, unsent].map((o) => matchesStatus(o, 'unsent'))).toEqual([false, false, true]);
    expect([sent, changed, unsent].map((o) => matchesStatus(o, 'changed'))).toEqual([false, true, false]);
    expect([sent, changed, unsent].map((o) => matchesStatus(o, 'all'))).toEqual([true, true, true]);
  });
});
