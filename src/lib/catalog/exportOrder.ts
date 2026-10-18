import { patchFirstSheet, type CellUpdate } from '../xlsx/xlsx';
import { qtyOf } from './selectors';
import { safeText } from './text';
import type { Catalog, QtyMap } from './types';

/** Builds the cell updates that write quantities (and the signer name on signature rows) back into the sheet. */
export function buildOrderUpdates(catalog: Catalog, qty: QtyMap, signer: string): CellUpdate[] {
  const name = safeText(signer);
  const updates: CellUpdate[] = [];
  for (const item of catalog.items) {
    for (const s of catalog.columns.sizeCols) {
      const q = qtyOf(qty, item.id, s.label);
      updates.push({ row: item.row, col: s.col, value: q > 0 ? q : '' });
      if (item.signatureRow) {
        updates.push({ row: item.signatureRow, col: s.col, value: q > 0 ? name : '' });
      }
    }
  }
  return updates;
}

export function exportFileName(excelName: string, signer: string, date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  const base = excelName.replace(/\.xlsx?$/i, '');
  const who = safeText(signer).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_');
  return base + '_ORDERED_' + (who ? who + '_' : '') + stamp + '.xlsx';
}

export async function buildOrderWorkbook(
  excelData: ArrayBuffer,
  catalog: Catalog,
  qty: QtyMap,
  signer: string,
): Promise<Blob> {
  const bytes = await patchFirstSheet(excelData, buildOrderUpdates(catalog, qty, signer));
  return new Blob([bytes as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
