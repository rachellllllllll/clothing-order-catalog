import type { CatalogDoc, DocProduct } from '../../../api/_types';
import { sizeRunText } from './sizes';
import { normalizeText } from './text';
import type { Catalog, CatalogItem, ModelGroup } from './types';

export type { CatalogDoc, DocColor, DocProduct } from '../../../api/_types';

/** Kids sizes: every year up to 10, then even only (2–10, 12, 14, … 22). */
const KIDS_NUMBERS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22];

/** Quick size sets for a new round or the sizes panel (a round may mix several). */
export const SIZE_PRESETS: { label: string; sizes: string[] }[] = [
  { label: 'מבוגרים', sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
  { label: 'תינוקות', sizes: ['3M', '6M', '9M', '12M', '18M', '24M'] },
  { label: 'ילדים (שנים)', sizes: KIDS_NUMBERS.map((n) => `${n}Y`) },
  { label: 'מספרים', sizes: KIDS_NUMBERS.map(String) },
];

/** Size labels as stored: trimmed and upper case ("3m" = "3M"). */
export function sizeLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Longest size label the server accepts. */
export const MAX_SIZE_LENGTH = 20;

const LETTER_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL'];
const LETTER_ALIAS: Record<string, string> = { '2XL': 'XXL', '3XL': 'XXXL', XXXXL: '4XL' };

/** [group, value]: babies (months), kids (years), plain numbers, letter sizes — or null for anything else. */
function sizeRank(size: string): [number, number] | null {
  const s = sizeLabel(size);
  let m = /^(?:\d+-)?(\d+(?:\.\d+)?)M$/.exec(s);
  if (m) return [0, Number(m[1])];
  m = /^(?:\d+-)?(\d+(?:\.\d+)?)Y$/.exec(s);
  if (m) return [1, Number(m[1])];
  if (/^\d+(?:\.\d+)?$/.test(s)) return [2, Number(s)];
  const i = LETTER_ORDER.indexOf(LETTER_ALIAS[s] ?? s);
  return i >= 0 ? [3, i] : null;
}

/** The usual order: 3M…24M, 2Y…16Y, 2…46, XS…XXL; other sizes (ONE SIZE…) last, in the order they were added. */
export function sortSizes(sizes: string[]): string[] {
  return sizes
    .map((s, i) => ({ s, i, r: sizeRank(s) }))
    .sort((a, b) => (a.r && b.r ? a.r[0] - b.r[0] || a.r[1] - b.r[1] : a.r ? -1 : b.r ? 1 : 0) || a.i - b.i)
    .map((x) => x.s);
}

/** Same as roundNameKey on the server: two rounds can't share a name. */
export const roundNameKey = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();

/** Short random id for products and colors (orders refer to items by `<product id>.<color id>`). */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

export function docItemId(product: DocProduct, colorId: string): string {
  return product.id + '.' + colorId;
}

/** "3M–12M" for a run of the round's sizes, otherwise the list; empty when the product comes in every size. */
function sizeRangeText(all: string[], sizes: string[]): string {
  if (!sizes.length || sizes.length === all.length) return '';
  return sizeRunText(all, sizes);
}

/** The catalog of a round edited on the admin page, in the shape the order page uses (like a parsed Excel file). */
export function catalogFromDoc(doc: CatalogDoc): Catalog {
  const sizeCols = doc.sizes.map((label, i) => ({ col: i + 1, label }));
  const items: CatalogItem[] = [];
  const groups: ModelGroup[] = [];
  for (const p of doc.products) {
    if (!p.model.trim()) continue;
    const group: ModelGroup = { model: p.model, key: normalizeText(p.model), variants: [] };
    for (const c of p.colors) {
      const item: CatalogItem = {
        id: docItemId(p, c.id),
        model: p.model,
        modelKey: group.key,
        price: p.price,
        color: c.name,
        notes: p.notes,
        sizeRange: sizeRangeText(doc.sizes, p.sizes),
        availableSizes: new Set(p.sizes),
        row: 0,
        signatureRow: null,
        signature: '',
        initialQty: {},
      };
      items.push(item);
      group.variants.push(item);
    }
    groups.push(group);
  }
  return {
    sheetName: '',
    // Every product lists its sizes, like an Excel file with a SIZE column (this enables the size filter).
    columns: { modelCol: 0, priceCol: 0, colorCol: 0, notesCol: 0, sizeRangeCol: 1, sizeCols },
    items,
    itemById: new Map(items.map((it) => [it.id, it])),
    groups,
  };
}
