import type { CellValue, SheetGrid } from '../xlsx/xlsx';
import { itemKey } from './draft';
import { computeAvailableSizes, isSizeHeader } from './sizes';
import { normalizeHeader, normalizeText, safeText } from './text';
import type { Catalog, CatalogItem, Columns, ModelGroup, SizeColumn } from './types';

const SIZE_RANGE_HEADERS = ['size', 'sizes', 'מידה', 'מידות'];
const NOTES_HEADERS = ['notes', 'note', 'remark', 'remarks', 'הערות', 'הערה'];
const FALLBACK_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

export function findHeaderRow(grid: SheetGrid): number {
  const scanRows = Math.min(grid.maxRow, 60);
  const scanCols = Math.min(grid.maxCol, 20);
  for (let r = 1; r <= scanRows; r += 1) {
    for (let c = 1; c <= scanCols; c += 1) {
      if (normalizeHeader(grid.get(r, c)) === 'model') return r;
    }
  }
  return -1;
}

export function detectColumns(grid: SheetGrid, headerRow: number): Columns {
  let modelCol = -1;
  let priceCol = -1;
  let colorCol = -1;
  let notesCol = -1;
  let sizeRangeCol = -1;
  let sizeCols: SizeColumn[] = [];

  for (let c = 1; c <= grid.maxCol; c += 1) {
    const raw = safeText(grid.get(headerRow, c));
    const txt = normalizeHeader(raw);
    if (txt === 'model') modelCol = c;
    if (txt === 'price') priceCol = c;
    if (txt === 'color') colorCol = c;
    if (SIZE_RANGE_HEADERS.includes(txt)) sizeRangeCol = c;
    if (NOTES_HEADERS.includes(txt)) notesCol = c;
    if (isSizeHeader(txt)) sizeCols.push({ col: c, label: raw.toUpperCase() });
  }

  if (modelCol === -1) throw new Error('לא נמצאה עמודת MODEL בשורת הכותרת.');

  // PRICE / COLOR headers can be missing in some files: infer them from MODEL's position.
  if (priceCol === -1) priceCol = modelCol + 1;
  if (colorCol === -1) colorCol = modelCol + 2;

  const isFree = (c: number) => c > 0 && c !== modelCol && c !== priceCol && c !== colorCol;

  if (notesCol === -1) {
    const candidate = sizeCols.length > 0 ? sizeCols[0].col - 1 : colorCol + 1;
    if (isFree(candidate)) notesCol = candidate;
  }

  const firstSizeCol = notesCol > 0 ? notesCol + 1 : colorCol + 1;
  if (sizeCols.length === 0) {
    for (let c = firstSizeCol; c <= grid.maxCol; c += 1) {
      const label = safeText(grid.get(headerRow, c));
      if (label) sizeCols.push({ col: c, label });
    }
  }
  if (sizeCols.length === 0) {
    sizeCols = FALLBACK_SIZES.map((label, i) => ({ col: firstSizeCol + i, label }));
  }

  return { modelCol, priceCol, colorCol, notesCol, sizeRangeCol, sizeCols };
}

export function parseQuantity(v: CellValue): number {
  if (v === '' || v == null) return 0;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function parsePrice(v: CellValue): number | null {
  if (typeof v === 'number') return v;
  const t = safeText(v);
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A signature row has non-numeric text (the signer name) in at least one size cell. */
function readSignature(grid: SheetGrid, row: number, sizeCols: SizeColumn[]): string {
  for (const s of sizeCols) {
    const t = safeText(grid.get(row, s.col));
    if (t && !Number.isFinite(Number(t))) return t;
  }
  return '';
}

export function parseCatalog(grid: SheetGrid): Catalog {
  const headerRow = findHeaderRow(grid);
  if (headerRow < 1) throw new Error('לא נמצאה שורת כותרת עם MODEL.');
  const columns = detectColumns(grid, headerRow);
  const { modelCol, priceCol, colorCol, notesCol, sizeRangeCol, sizeCols } = columns;

  const items: CatalogItem[] = [];
  const seenKeys = new Map<string, number>();
  for (let r = headerRow + 1; r <= grid.maxRow; r += 1) {
    const model = safeText(grid.get(r, modelCol));
    if (!model) continue;

    const color = safeText(grid.get(r, colorCol));
    const sizeRange = sizeRangeCol > 0 ? safeText(grid.get(r, sizeRangeCol)) : '';
    const initialQty: Record<string, number> = {};
    for (const s of sizeCols) initialQty[s.label] = parseQuantity(grid.get(r, s.col));

    // The row below may be a "signature" row for the same model: it repeats MODEL
    // (and COLOR, or leaves it empty) and holds the signer name in the size cells.
    let signatureRow: number | null = null;
    let signature = '';
    if (r < grid.maxRow) {
      const next = r + 1;
      const nextModel = safeText(grid.get(next, modelCol));
      const nextColor = safeText(grid.get(next, colorCol));
      const nextSignature = readSignature(grid, next, sizeCols);
      const sameModel = normalizeText(nextModel) === normalizeText(model);
      const sameColor = normalizeText(nextColor) === normalizeText(color);
      if (sameModel && (sameColor || !nextColor || nextSignature)) {
        signatureRow = next;
        signature = nextSignature;
      }
    }

    // A repeated model + color (a data error in the file) still needs a unique id.
    const key = itemKey(model, color);
    const seen = (seenKeys.get(key) ?? 0) + 1;
    seenKeys.set(key, seen);

    items.push({
      id: seen === 1 ? key : key + '#' + seen,
      model,
      modelKey: normalizeText(model),
      price: parsePrice(grid.get(r, priceCol)),
      color,
      notes: notesCol > 0 ? safeText(grid.get(r, notesCol)) : '',
      sizeRange,
      availableSizes: computeAvailableSizes(sizeRange, sizeCols),
      row: r,
      signatureRow,
      signature,
      initialQty,
    });

    if (signatureRow) r = signatureRow;
  }

  const byModel = new Map<string, ModelGroup>();
  for (const item of items) {
    let g = byModel.get(item.modelKey);
    if (!g) {
      g = { model: item.model, key: item.modelKey, variants: [] };
      byModel.set(item.modelKey, g);
    }
    g.variants.push(item);
  }

  return {
    sheetName: grid.sheetName,
    columns,
    items,
    itemById: new Map(items.map((it) => [it.id, it])),
    groups: Array.from(byModel.values()),
  };
}
