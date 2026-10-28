import type { Catalog, CartLine, CatalogItem, ModelGroup, QtyMap, SizeFilterMode, SortMode } from './types';

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

/** Sizes that at least one product is actually available in; empty when the file has no SIZE range column. */
export function offeredFilterSizes(catalog: Catalog): string[] {
  if (catalog.columns.sizeRangeCol <= 0) return [];
  const offered = new Set<string>();
  for (const it of catalog.items) it.availableSizes?.forEach((s) => offered.add(s));
  return catalog.columns.sizeCols.map((s) => s.label).filter((l) => offered.has(l));
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

export interface CartTotals {
  units: number;
  amount: number;
  unpricedUnits: number;
}

export function cartTotals(lines: CartLine[]): CartTotals {
  const t: CartTotals = { units: 0, amount: 0, unpricedUnits: 0 };
  for (const l of lines) {
    t.units += l.qty;
    if (l.subtotal == null) t.unpricedUnits += l.qty;
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
