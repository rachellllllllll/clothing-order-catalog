import { describe, expect, it } from 'vitest';
import { catalogFromDoc, sizeLabel, sortSizes, type CatalogDoc } from './catalogDoc';
import { offeredFilterSizes } from './selectors';

const doc: CatalogDoc = {
  v: 1,
  sizes: ['3M', '6M', '9M', '12M', '2Y'],
  products: [
    {
      id: 'p1',
      model: 'Body',
      price: 5,
      notes: 'cotton',
      sizes: ['3M', '6M', '9M'],
      colors: [
        { id: 'c1', name: 'Red' },
        { id: 'c2', name: 'Blue' },
      ],
      image: null,
    },
    { id: 'p2', model: 'Hat', price: null, notes: '', sizes: ['3M', '6M', '9M', '12M', '2Y'], colors: [{ id: 'c3', name: '' }], image: null },
    { id: 'p3', model: '  ', price: 1, notes: '', sizes: ['3M'], colors: [{ id: 'c4', name: '' }], image: null },
  ],
};

describe('catalogFromDoc', () => {
  const catalog = catalogFromDoc(doc);

  it('makes one item per color, with stable ids, and skips products without a model', () => {
    expect(catalog.items.map((it) => it.id)).toEqual(['p1.c1', 'p1.c2', 'p2.c3']);
    expect(catalog.groups.map((g) => g.model)).toEqual(['Body', 'Hat']);
    expect(catalog.itemById.get('p1.c2')).toMatchObject({ model: 'Body', color: 'Blue', price: 5, notes: 'cotton' });
  });

  it('keeps the round sizes as columns and each product its own sizes', () => {
    expect(catalog.columns.sizeCols.map((c) => c.label)).toEqual(doc.sizes);
    const body = catalog.itemById.get('p1.c1')!;
    expect([...body.availableSizes!]).toEqual(['3M', '6M', '9M']);
    expect(body.sizeRange).toBe('3M–9M');
    expect(catalog.itemById.get('p2.c3')!.sizeRange).toBe('');
    expect(offeredFilterSizes(catalog)).toEqual(doc.sizes);
  });

  it('offers no size filter when every product comes in every size', () => {
    const sizes = ['XS', 'S', 'M'];
    const full = catalogFromDoc({
      v: 1,
      sizes,
      products: [
        { id: 'p1', model: 'Tee', price: 1, notes: '', sizes, colors: [{ id: 'c1', name: '' }], image: null },
        { id: 'p2', model: 'Top', price: 1, notes: '', sizes, colors: [{ id: 'c2', name: '' }], image: null },
      ],
    });
    expect(offeredFilterSizes(full)).toEqual([]);
  });

  it('normalizes size labels', () => {
    expect(sizeLabel('  3m ')).toBe('3M');
    expect(sizeLabel('one   size')).toBe('ONE SIZE');
  });
});

describe('sortSizes', () => {
  it('orders babies, kids, numbers and letter sizes; unknown sizes last as added', () => {
    expect(sortSizes(['XL', 'ONE SIZE', 'S', '12M', '38', '2Y', '3M', '36', '10Y', 'XXS', 'Free', '3-6M', '3XL'])).toEqual([
      '3M',
      '3-6M',
      '12M',
      '2Y',
      '10Y',
      '36',
      '38',
      'XXS',
      'S',
      'XL',
      '3XL',
      'ONE SIZE',
      'Free',
    ]);
  });
});
