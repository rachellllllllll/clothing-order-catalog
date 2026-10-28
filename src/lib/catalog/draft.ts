import { qtyOf } from './selectors';
import { normalizeText, safeText } from './text';
import type { Catalog, QtyMap } from './types';

/** One ordered quantity, identified by stable item id (model + color) and size label — never by Excel row. */
export interface DraftLine {
  id: string;
  model: string;
  color: string;
  size: string;
  qty: number;
}

export interface Draft {
  /** ISO timestamp of the last quantity change. */
  updatedAt: string;
  lines: DraftLine[];
  /** Server orders only: the server revision these lines were edited from. */
  baseRev?: number;
  /** Server orders only: true while these lines are not yet saved on the server. */
  dirty?: boolean;
}

/** Identity of an order's content (ignores line order and the human-readable model/color labels). */
export function linesKey(lines: readonly Pick<DraftLine, 'id' | 'size' | 'qty'>[]): string {
  return lines
    .map((l) => l.id + '\u0001' + l.size + '\u0001' + l.qty)
    .sort()
    .join('\n');
}

/** Stable item id: the same model + color keeps its id when rows are inserted, moved or re-priced. */
export function itemKey(model: string, color: string): string {
  return normalizeText(model) + '|' + normalizeText(color);
}

export function qtyToLines(catalog: Catalog, qty: QtyMap): DraftLine[] {
  const lines: DraftLine[] = [];
  for (const item of catalog.items) {
    for (const { label } of catalog.columns.sizeCols) {
      const q = qtyOf(qty, item.id, label);
      if (q > 0) lines.push({ id: item.id, model: item.model, color: item.color, size: label, qty: q });
    }
  }
  return lines;
}

/** The quantities typed into an Excel file (e.g. a previously downloaded order). */
export function catalogFileLines(catalog: Catalog): DraftLine[] {
  const lines: DraftLine[] = [];
  for (const item of catalog.items) {
    for (const { label } of catalog.columns.sizeCols) {
      const q = item.initialQty[label] ?? 0;
      if (q > 0) lines.push({ id: item.id, model: item.model, color: item.color, size: label, qty: q });
    }
  }
  return lines;
}

/** Maps saved lines onto the current catalog; lines whose item or size column no longer exists are returned as `missing`. */
export function linesToQty(catalog: Catalog, lines: DraftLine[]): { qty: QtyMap; missing: DraftLine[] } {
  const sizeByKey = new Map(catalog.columns.sizeCols.map((s) => [normalizeText(s.label), s.label]));
  const qty: QtyMap = {};
  const missing: DraftLine[] = [];
  for (const line of lines) {
    const item = catalog.itemById.get(line.id);
    const size = sizeByKey.get(normalizeText(line.size));
    if (!item || !size) {
      missing.push(line);
      continue;
    }
    const sizes = (qty[item.id] ??= {});
    sizes[size] = (sizes[size] ?? 0) + line.qty;
  }
  return { qty, missing };
}

/** Parses a stored draft, dropping anything malformed (storage content is not trusted). */
export function parseDraft(raw: string | null): Draft | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { updatedAt, lines, baseRev, dirty } = data as { updatedAt?: unknown; lines?: unknown; baseRev?: unknown; dirty?: unknown };
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt)) || !Array.isArray(lines)) return null;

  const valid: DraftLine[] = [];
  for (const l of lines as Record<string, unknown>[]) {
    if (!l || typeof l !== 'object') continue;
    const qty = typeof l.qty === 'number' && Number.isFinite(l.qty) ? Math.floor(l.qty) : 0;
    if (qty <= 0 || typeof l.id !== 'string' || typeof l.size !== 'string') continue;
    valid.push({ id: l.id, model: safeText(l.model), color: safeText(l.color), size: l.size, qty });
  }
  const draft: Draft = { updatedAt, lines: valid };
  if (typeof baseRev === 'number' && Number.isInteger(baseRev)) draft.baseRev = baseRev;
  if (dirty === true) draft.dirty = true;
  return draft;
}
