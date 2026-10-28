import type { OrderDto, OrderLine } from '../../../api/_types';
import { patchFirstSheet, type CellUpdate } from '../xlsx/xlsx';
import type { Catalog } from './types';

/** 'submitted' = the last sent version of each order; 'current' = what each orderer has now (sent or not). */
export type CombineMode = 'submitted' | 'current';

export interface CombinedOrder {
  updates: CellUpdate[];
  /** Orderers whose lines were added, with their units. */
  included: { name: string; units: number }[];
  /** Orderers left out (nothing sent, in 'submitted' mode, or an empty order). */
  skipped: string[];
  /** Lines whose item or size is no longer in the catalog. */
  missing: { name: string; line: OrderLine }[];
  units: number;
}

/**
 * Sums all orders into the catalog sheet: total quantity per item + size, and "name qty, name qty"
 * on the signature row (when the sheet has one).
 */
export function combineOrders(catalog: Catalog, orders: readonly OrderDto[], mode: CombineMode): CombinedOrder {
  const sizes = new Set(catalog.columns.sizeCols.map((s) => s.label));
  const totals = new Map<string, number>();
  const names = new Map<string, string[]>();
  const result: CombinedOrder = { updates: [], included: [], skipped: [], missing: [], units: 0 };

  const sorted = [...orders].sort((a, b) => a.name.localeCompare(b.name, 'he'));
  for (const order of sorted) {
    const lines = mode === 'submitted' ? order.submitted?.lines : order.lines;
    const units = lines?.reduce((s, l) => s + l.qty, 0) ?? 0;
    if (!lines || units === 0) {
      result.skipped.push(order.name);
      continue;
    }
    result.included.push({ name: order.name, units });
    for (const line of lines) {
      if (!catalog.itemById.has(line.id) || !sizes.has(line.size)) {
        result.missing.push({ name: order.name, line });
        continue;
      }
      const key = line.id + '\u0001' + line.size;
      totals.set(key, (totals.get(key) ?? 0) + line.qty);
      names.set(key, [...(names.get(key) ?? []), `${order.name} ${line.qty}`]);
      result.units += line.qty;
    }
  }

  for (const item of catalog.items) {
    for (const s of catalog.columns.sizeCols) {
      const key = item.id + '\u0001' + s.label;
      result.updates.push({ row: item.row, col: s.col, value: totals.get(key) ?? '' });
      if (item.signatureRow) {
        result.updates.push({ row: item.signatureRow, col: s.col, value: names.get(key)?.join(', ') ?? '' });
      }
    }
  }
  return result;
}

export async function buildCombinedWorkbook(excelData: ArrayBuffer, combined: CombinedOrder): Promise<Blob> {
  const bytes = await patchFirstSheet(excelData, combined.updates);
  return new Blob([bytes as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export function combinedFileName(excelName: string, date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  return excelName.replace(/\.xlsx?$/i, '') + '_ALL_ORDERS_' + stamp + '.xlsx';
}
