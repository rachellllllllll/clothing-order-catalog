import type { CatalogDoc, DocProduct } from '../../../api/_types';
import { normalizeText } from './text';
import type { Catalog, CatalogItem, ModelGroup } from './types';

export type { CatalogDoc, DocColor, DocProduct } from '../../../api/_types';

/** Quick size sets for a new round or the sizes panel (a round may mix several). */
export const SIZE_PRESETS: { label: string; sizes: string[] }[] = [
  { label: 'מבוגרים', sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
  { label: 'תינוקות', sizes: ['3M', '6M', '9M', '12M', '18M', '24M', '30M', '36M'] },
  { label: 'ילדים (שנים)', sizes: Array.from({ length: 17 }, (_, i) => `${i + 2}Y`) },
  { label: 'מספרים', sizes: Array.from({ length: 15 }, (_, i) => String(i + 2)) },
];

/** Size labels as stored: trimmed and upper case ("3m" = "3M"). */
export function sizeLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

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
  const idx = sizes.map((s) => all.indexOf(s)).sort((a, b) => a - b);
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (contiguous && idx.length > 2) return all[idx[0]] + '–' + all[idx[idx.length - 1]];
  return idx.map((i) => all[i]).join(', ');
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
