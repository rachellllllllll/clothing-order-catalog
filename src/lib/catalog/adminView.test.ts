import { describe, expect, it } from 'vitest';
import type { OrderDto, OrderLine, OrderSummary } from '../../../api/_types';
import { buildXlsx } from '../../test/buildXlsx';
import { readFirstSheet } from '../xlsx/xlsx';
import { linesTotals, matchesStatus, orderDetail, productsView, unsentNote, unsentUnits } from './adminView';
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
  it('sums the sent version per item and size, with who ordered what and what is not sent yet', async () => {
    const cat = await catalog();
    const [coat, hat] = cat.items;
    const orders = new Map([
      ['f1', order('רונית', [l(coat.id, 'M', 5)], [l(coat.id, 'M', 1), l(hat.id, 'S', 2)])],
      ['f2', order('אבי', [l(coat.id, 'L', 1)], [l(coat.id, 'M', 2), l('gone|item', 'S', 1), l(coat.id, 'XL', 1)])],
      ['f3', order('דנה', [l(coat.id, 'M', 1)], null)],
    ]);

    const sent = productsView(cat, orders);
    const coatRow = sent.rows.find((r) => r.item.id === coat.id)!;
    expect(coatRow.qty).toEqual({ M: 3 });
    expect(coatRow.who.M).toEqual([
      { fileId: 'f2', name: 'אבי', qty: 2, missing: 0 },
      { fileId: 'f1', name: 'רונית', qty: 1, missing: 0 },
    ]);
    expect(sent.sizes).toEqual(['S', 'M']);
    expect(sent.sizeTotals).toEqual({ S: 2, M: 3 });
    expect(sent.totals).toEqual({ units: 5, amount: 600, unpricedUnits: 2, missingUnits: 0, missingAmount: 0 });
    expect(sent.missing.map((m) => [m.name, m.line.id, m.line.size])).toEqual([
      ['אבי', 'gone|item', 'S'],
      ['אבי', coat.id, 'XL'],
    ]);
    // Current coat units: 5 + 1 (L) + 1 (draft) = 7 against 3 sent; the hat was removed (2 sent, 0 now).
    expect(coatRow.pending).toBe(4);
    expect(sent.rows.find((r) => r.item.id === hat.id)!.pending).toBe(-2);
  });

  it('counts units that did not arrive, never more than were ordered', async () => {
    const cat = await catalog();
    const [coat] = cat.items;
    const orders = new Map([
      ['f1', order('רונית', [l(coat.id, 'M', 1)], [l(coat.id, 'M', 1)])],
      ['f2', order('אבי', [l(coat.id, 'M', 3)], [l(coat.id, 'M', 3)])],
    ]);
    const view = productsView(cat, orders, {
      f1: [{ id: coat.id, size: 'M', qty: 5 }],
      f2: [{ id: coat.id, size: 'M', qty: 1 }, { id: coat.id, size: 'L', qty: 1 }],
    });
    const row = view.rows.find((r) => r.item.id === coat.id)!;
    expect(row.missing).toEqual({ M: 2 });
    expect(row.missingUnits).toBe(2);
    expect(row.who.M.map((w) => [w.name, w.qty, w.missing])).toEqual([
      ['אבי', 3, 1],
      ['רונית', 1, 1],
    ]);
    expect(view.totals).toEqual({ units: 4, amount: 400, unpricedUnits: 0, missingUnits: 2, missingAmount: 400 });
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
      missingUnits: 0,
      missingAmount: 0,
    });
  });

  it('leaves units that did not arrive out of the amount to pay', async () => {
    const cat = await catalog();
    const [coat, hat] = cat.items;
    const short = [
      { id: coat.id, size: 'M', qty: 1 },
      { id: hat.id, size: 'S', qty: 1 },
    ];
    expect(linesTotals(cat, [l(coat.id, 'M', 2), l(hat.id, 'S', 1)], short)).toEqual({
      units: 3,
      amount: 200,
      unpricedUnits: 0,
      missingUnits: 2,
      missingAmount: 200,
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

describe('unsentUnits', () => {
  const s = (fileId: string, units: number, submittedRev: number | null, rev = 2): OrderSummary => ({
    fileId,
    name: fileId,
    rev,
    units,
    updatedAt: '',
    submittedAt: submittedRev === null ? null : '2026-01-01',
    submittedRev,
  });
  const sent: Record<string, number> = { up: 2, down: 5, same: 4 };

  it('counts drafts and additions as left out, removals as still counted', () => {
    const rows = [s('draft', 3, null), s('up', 4, 1), s('down', 2, 1), s('same', 9, 2)];
    const res = unsentUnits(rows, (o) => sent[o.fileId]);
    expect(res).toEqual({ added: 5, removed: 3 });
    expect(unsentNote(res)).toBe('+5 ממתינות לשליחה · 3 שהוסרו עדיין נספרות');
    expect(unsentNote({ added: 0, removed: 0 })).toBe('');
  });
});
