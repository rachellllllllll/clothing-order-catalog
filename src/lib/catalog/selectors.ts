import type { ShortageLine } from '../../../api/_types';
import { missingQty, shortageIndex } from './shortages';
import { sizeRunText } from './sizes';
import type { Catalog, CartLine, CatalogItem, ModelGroup, QtyMap, SizeColumn, SizeFilterMode, SortMode } from './types';

export function qtyOf(qty: QtyMap, itemId: string, size: string): number {
  return qty[itemId]?.[size] ?? 0;
}

export function variantUnits(qty: QtyMap, item: CatalogItem): number {
  const m = qty[item.id];
  if (!m) return 0;
  let n = 0;
  for (const v of Object.values(m)) n += v;
  return n;
}

export function groupUnits(qty: QtyMap, group: ModelGroup): number {
  return group.variants.reduce((s, v) => s + variantUnits(qty, v), 0);
}

export function isSizeAvailable(item: CatalogItem, size: string): boolean {
  return !item.availableSizes || item.availableSizes.has(size);
}

/** The sizes a variant comes in, e.g. "XS–XL" or "2Y–6Y, 10Y" (an unparsed Excel range text is shown as is). */
export function itemSizesText(item: CatalogItem, sizeCols: readonly SizeColumn[]): string {
  if (!item.availableSizes && item.sizeRange) return item.sizeRange;
  const all = sizeCols.map((c) => c.label);
  return sizeRunText(all, all.filter((l) => isSizeAvailable(item, l)));
}

/** Saved tab choice, else the first variant that has quantities, else the first variant. */
export function activeVariantIndex(group: ModelGroup, qty: QtyMap, saved: number | undefined): number {
  if (saved != null && saved >= 0 && saved < group.variants.length) return saved;
  const idx = group.variants.findIndex((v) => variantUnits(qty, v) > 0);
  return idx >= 0 ? idx : 0;
}

export interface GroupFilter {
  search: string;
  sort: SortMode;
  sizeFilter: readonly string[];
  sizeFilterMode: SizeFilterMode;
  onlyOrdered: boolean;
}

function minPrice(g: ModelGroup, fallback: number): number {
  return Math.min(...g.variants.map((v) => v.price ?? fallback));
}

export function filterGroups(groups: ModelGroup[], qty: QtyMap, f: GroupFilter): ModelGroup[] {
  const q = f.search.trim().toLowerCase();
  let out = groups;

  if (f.onlyOrdered) out = out.filter((g) => groupUnits(qty, g) > 0);

  if (q) {
    out = out.filter(
      (g) => g.model.toLowerCase().includes(q) || g.variants.some((v) => v.color.toLowerCase().includes(q)),
    );
  }

  if (f.sizeFilter.length > 0) {
    const matches = (v: CatalogItem) => {
      // No availability data means the variant is available in every size.
      if (!v.availableSizes) return true;
      const has = (sz: string) => v.availableSizes!.has(sz);
      return f.sizeFilterMode === 'all' ? f.sizeFilter.every(has) : f.sizeFilter.some(has);
    };
    out = out.filter((g) => g.variants.some(matches));
  }

  out = out.slice();
  switch (f.sort) {
    case 'name':
      out.sort((a, b) => a.model.localeCompare(b.model, 'he'));
      break;
    case 'price-asc':
      out.sort((a, b) => minPrice(a, Infinity) - minPrice(b, Infinity));
      break;
    case 'price-desc':
      out.sort((a, b) => minPrice(b, -Infinity) - minPrice(a, -Infinity));
      break;
    case 'ordered':
      out.sort((a, b) => groupUnits(qty, b) - groupUnits(qty, a));
      break;
  }
  return out;
}

/**
 * Sizes that at least one product is actually available in; empty when the file has no SIZE range column, or when
 * every product comes in every size (the filter would not hide anything).
 */
export function offeredFilterSizes(catalog: Catalog): string[] {
  if (catalog.columns.sizeRangeCol <= 0) return [];
  const all = catalog.columns.sizeCols.map((s) => s.label);
  const offered = new Set<string>();
  let narrows = false;
  for (const it of catalog.items) {
    if (!it.availableSizes) continue;
    it.availableSizes.forEach((s) => offered.add(s));
    if (!narrows) narrows = all.some((l) => !it.availableSizes!.has(l));
  }
  return narrows ? all.filter((l) => offered.has(l)) : [];
}

export function cartLines(catalog: Catalog, qty: QtyMap): CartLine[] {
  const lines: CartLine[] = [];
  for (const item of catalog.items) {
    for (const { label } of catalog.columns.sizeCols) {
      const q = qtyOf(qty, item.id, label);
      if (q <= 0) continue;
      lines.push({
        itemId: item.id,
        model: item.model,
        color: item.color || '-',
        size: label,
        qty: q,
        price: item.price,
        subtotal: item.price == null ? null : item.price * q,
        notes: item.notes,
      });
    }
  }
  return lines;
}

/** Marks the units that did not arrive; their price is left out of the subtotal. */
export function withShortages(lines: CartLine[], shortages: readonly ShortageLine[]): CartLine[] {
  if (!shortages.length) return lines;
  const index = shortageIndex(shortages);
  return lines.map((l) => {
    const missing = missingQty(index, l.itemId, l.size, l.qty);
    return missing ? { ...l, missing, subtotal: l.price == null ? null : l.price * (l.qty - missing) } : l;
  });
}

export interface CartTotals {
  units: number;
  /** To pay: the units that arrived. */
  amount: number;
  /** Arrived units with no price. */
  unpricedUnits: number;
  missingUnits: number;
}

export function cartTotals(lines: CartLine[]): CartTotals {
  const t: CartTotals = { units: 0, amount: 0, unpricedUnits: 0, missingUnits: 0 };
  for (const l of lines) {
    const missing = l.missing ?? 0;
    t.units += l.qty;
    t.missingUnits += missing;
    if (l.subtotal == null) t.unpricedUnits += l.qty - missing;
    else t.amount += l.subtotal;
  }
  return t;
}

export function groupLinesByModel(lines: CartLine[]): Map<string, CartLine[]> {
  const byModel = new Map<string, CartLine[]>();
  for (const l of lines) {
    const arr = byModel.get(l.model);
    if (arr) arr.push(l);
    else byModel.set(l.model, [l]);
  }
  return byModel;
}
