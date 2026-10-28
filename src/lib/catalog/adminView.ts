import type { OrderDto, OrderLine, OrderSummary } from '../../../api/_types';
import type { CombineMode } from './combinedOrder';
import type { Catalog, CatalogItem } from './types';

/** Orderers list filter: every order, sent (in any version), never sent, or changed after sending. */
export type StatusFilter = 'all' | 'sent' | 'unsent' | 'changed';

export const isChangedAfterSend = (o: OrderSummary) => !!o.submittedAt && o.submittedRev !== o.rev;

export function matchesStatus(o: OrderSummary, filter: StatusFilter): boolean {
  switch (filter) {
    case 'sent':
      return !!o.submittedAt;
    case 'unsent':
      return !o.submittedAt;
    case 'changed':
      return isChangedAfterSend(o);
    default:
      return true;
  }
}

/** The lines of the chosen version ('submitted' = the last sent one, none if never sent). */
export function versionLines(order: OrderDto, version: CombineMode): OrderLine[] {
  return (version === 'submitted' ? order.submitted?.lines : order.lines) ?? [];
}

export interface Totals {
  units: number;
  /** Sum of priced units (catalog price × qty). */
  amount: number;
  /** Units with no price in the catalog (or no longer in it). */
  unpricedUnits: number;
}

export function linesTotals(catalog: Catalog, lines: readonly OrderLine[]): Totals {
  const t: Totals = { units: 0, amount: 0, unpricedUnits: 0 };
  for (const l of lines) {
    t.units += l.qty;
    const price = catalog.itemById.get(l.id)?.price;
    if (price == null) t.unpricedUnits += l.qty;
    else t.amount += price * l.qty;
  }
  return t;
}

export interface ProductRow {
  item: CatalogItem;
  /** size label -> ordered quantity */
  qty: Record<string, number>;
  /** size label -> who ordered it (by name) */
  who: Record<string, { name: string; qty: number }[]>;
  units: number;
}

export interface ProductsView {
  /** Every catalog item, in catalog (Excel) order. */
  rows: ProductRow[];
  /** Size columns that have any quantity, in catalog order. */
  sizes: string[];
  sizeTotals: Record<string, number>;
  totals: Totals;
  /** Lines whose item or size is no longer in the catalog (left out of the rows, as in the combined Excel). */
  missing: { name: string; line: OrderLine }[];
}

/** All orders of a round summed per catalog item and size — the combined Excel, as data for the screen. */
export function productsView(catalog: Catalog, orders: readonly OrderDto[], version: CombineMode): ProductsView {
  const sizeLabels = catalog.columns.sizeCols.map((s) => s.label);
  const knownSizes = new Set(sizeLabels);
  const rows = new Map<string, ProductRow>(catalog.items.map((item) => [item.id, { item, qty: {}, who: {}, units: 0 }]));
  const missing: ProductsView['missing'] = [];

  const sorted = [...orders].sort((a, b) => a.name.localeCompare(b.name, 'he'));
  for (const order of sorted) {
    for (const line of versionLines(order, version)) {
      const row = rows.get(line.id);
      if (!row || !knownSizes.has(line.size)) {
        missing.push({ name: order.name, line });
        continue;
      }
      row.qty[line.size] = (row.qty[line.size] ?? 0) + line.qty;
      (row.who[line.size] ??= []).push({ name: order.name, qty: line.qty });
      row.units += line.qty;
    }
  }

  const sizeTotals: Record<string, number> = {};
  const totals: Totals = { units: 0, amount: 0, unpricedUnits: 0 };
  for (const row of rows.values()) {
    for (const [size, qty] of Object.entries(row.qty)) sizeTotals[size] = (sizeTotals[size] ?? 0) + qty;
    totals.units += row.units;
    if (row.item.price == null) totals.unpricedUnits += row.units;
    else totals.amount += row.item.price * row.units;
  }

  return { rows: [...rows.values()], sizes: sizeLabels.filter((s) => sizeTotals[s]), sizeTotals, totals, missing };
}

export interface DetailRow {
  id: string;
  model: string;
  color: string;
  size: string;
  /** undefined = no longer in the catalog */
  item: CatalogItem | undefined;
  /** Quantity in the last sent version (0 if not there). */
  sent: number;
  /** Quantity in the current version (0 if removed). */
  current: number;
}

/** One order's lines in both versions side by side, in catalog row and size-column order. */
export function orderDetail(catalog: Catalog, order: OrderDto): DetailRow[] {
  const rows = new Map<string, DetailRow>();
  const add = (l: OrderLine, field: 'sent' | 'current') => {
    const key = l.id + '|' + l.size;
    const item = catalog.itemById.get(l.id);
    const row = rows.get(key) ?? {
      id: l.id,
      model: item?.model ?? l.model,
      color: item?.color ?? l.color,
      size: l.size,
      item,
      sent: 0,
      current: 0,
    };
    row[field] += l.qty;
    rows.set(key, row);
  };
  for (const l of order.submitted?.lines ?? []) add(l, 'sent');
  for (const l of order.lines) add(l, 'current');

  const LAST = Number.MAX_SAFE_INTEGER;
  const sizeIndex = new Map(catalog.columns.sizeCols.map((s, i) => [s.label, i]));
  return [...rows.values()].sort(
    (a, b) => (a.item?.row ?? LAST) - (b.item?.row ?? LAST) || (sizeIndex.get(a.size) ?? LAST) - (sizeIndex.get(b.size) ?? LAST),
  );
}
