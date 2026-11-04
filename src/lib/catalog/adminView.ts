import type { OrderDto, OrderLine, OrderSummary, ShortageLine, Shortages } from '../../../api/_types';
import { missingQty, shortageIndex } from './shortages';
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

/**
 * How far the orders as they are now differ from the sent versions the totals count: units in drafts or added
 * after sending (left out), and units removed after sending (still counted). Per order, so a swap inside one order
 * shows in neither.
 */
export function unsentUnits(
  rows: readonly OrderSummary[],
  sentUnits: (o: OrderSummary) => number | undefined,
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const o of rows) {
    if (!o.submittedAt) added += o.units;
    else if (isChangedAfterSend(o)) {
      const sent = sentUnits(o);
      if (sent === undefined) continue;
      added += Math.max(0, o.units - sent);
      removed += Math.max(0, sent - o.units);
    }
  }
  return { added, removed };
}

export const unsentNote = ({ added, removed }: { added: number; removed: number }) =>
  [added > 0 && `+${added} ממתינות לשליחה`, removed > 0 && `${removed} שהוסרו עדיין נספרות`]
    .filter(Boolean)
    .join(' · ');

/** The lines of the last sent version — what is ordered from the supplier and charged (none if never sent). */
export function sentLines(order: OrderDto): OrderLine[] {
  return order.submitted?.lines ?? [];
}

export interface Totals {
  /** Ordered units. */
  units: number;
  /** To pay: catalog price × the units that arrived. */
  amount: number;
  /** Arrived units with no price in the catalog (or no longer in it). */
  unpricedUnits: number;
  /** Units marked as not arrived from the supplier, and their catalog price (left out of `amount`). */
  missingUnits: number;
  missingAmount: number;
}

export const emptyTotals = (): Totals => ({ units: 0, amount: 0, unpricedUnits: 0, missingUnits: 0, missingAmount: 0 });

export function addTotals(sum: Totals, t: Totals): void {
  sum.units += t.units;
  sum.amount += t.amount;
  sum.unpricedUnits += t.unpricedUnits;
  sum.missingUnits += t.missingUnits;
  sum.missingAmount += t.missingAmount;
}

function addUnits(t: Totals, price: number | null | undefined, qty: number, missing: number) {
  t.units += qty;
  t.missingUnits += missing;
  if (price == null) t.unpricedUnits += qty - missing;
  else {
    t.amount += price * (qty - missing);
    t.missingAmount += price * missing;
  }
}

export function linesTotals(catalog: Catalog, lines: readonly OrderLine[], shortages?: readonly ShortageLine[]): Totals {
  const t = emptyTotals();
  const index = shortageIndex(shortages);
  for (const l of lines) addUnits(t, catalog.itemById.get(l.id)?.price, l.qty, missingQty(index, l.id, l.size, l.qty));
  return t;
}

export interface WhoOrdered {
  fileId: string;
  name: string;
  qty: number;
  /** Units of this line marked as not arrived. */
  missing: number;
}

export interface ProductRow {
  item: CatalogItem;
  /** size label -> ordered quantity */
  qty: Record<string, number>;
  /** size label -> units that did not arrive */
  missing: Record<string, number>;
  /** size label -> who ordered it (by name) */
  who: Record<string, WhoOrdered[]>;
  units: number;
  missingUnits: number;
  /** Units not sent yet: drafts and changes since sending (current − sent; negative when units were removed). */
  pending: number;
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

/** The sent version of all orders of a round (by order file id) summed per catalog item and size. */
export function productsView(catalog: Catalog, orders: ReadonlyMap<string, OrderDto>, shortages: Shortages = {}): ProductsView {
  const sizeLabels = catalog.columns.sizeCols.map((s) => s.label);
  const knownSizes = new Set(sizeLabels);
  const rows = new Map<string, ProductRow>(
    catalog.items.map((item) => [item.id, { item, qty: {}, missing: {}, who: {}, units: 0, missingUnits: 0, pending: 0 }]),
  );
  const missing: ProductsView['missing'] = [];

  const sorted = [...orders].sort(([, a], [, b]) => a.name.localeCompare(b.name, 'he'));
  for (const [fileId, order] of sorted) {
    for (const line of order.lines) {
      const row = rows.get(line.id);
      if (row && knownSizes.has(line.size)) row.pending += line.qty;
    }
    const index = shortageIndex(shortages[fileId]);
    for (const line of sentLines(order)) {
      const row = rows.get(line.id);
      if (!row || !knownSizes.has(line.size)) {
        missing.push({ name: order.name, line });
        continue;
      }
      row.pending -= line.qty;
      const short = missingQty(index, line.id, line.size, line.qty);
      row.qty[line.size] = (row.qty[line.size] ?? 0) + line.qty;
      if (short) row.missing[line.size] = (row.missing[line.size] ?? 0) + short;
      (row.who[line.size] ??= []).push({ fileId, name: order.name, qty: line.qty, missing: short });
      row.units += line.qty;
      row.missingUnits += short;
    }
  }

  const sizeTotals: Record<string, number> = {};
  const totals = emptyTotals();
  for (const row of rows.values()) {
    for (const [size, qty] of Object.entries(row.qty)) sizeTotals[size] = (sizeTotals[size] ?? 0) + qty;
    addUnits(totals, row.item.price, row.units, row.missingUnits);
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
