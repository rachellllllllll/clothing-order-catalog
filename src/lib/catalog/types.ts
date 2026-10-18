export interface SizeColumn {
  col: number;
  label: string;
}

export interface Columns {
  modelCol: number;
  priceCol: number;
  colorCol: number;
  notesCol: number;
  sizeRangeCol: number;
  sizeCols: SizeColumn[];
}

export interface CatalogItem {
  id: string;
  model: string;
  modelKey: string;
  price: number | null;
  color: string;
  notes: string;
  sizeRange: string;
  /** null = available in every size column. */
  availableSizes: ReadonlySet<string> | null;
  /** 1-based Excel row holding the quantities. */
  row: number;
  /** 1-based Excel row holding the signer name per size, if the file has one. */
  signatureRow: number | null;
  signature: string;
  initialQty: Record<string, number>;
}

export interface ModelGroup {
  model: string;
  key: string;
  variants: CatalogItem[];
}

export interface Catalog {
  sheetName: string;
  columns: Columns;
  items: CatalogItem[];
  itemById: ReadonlyMap<string, CatalogItem>;
  groups: ModelGroup[];
}

/** itemId -> size label -> quantity */
export type QtyMap = Record<string, Record<string, number>>;

export type SortMode = 'default' | 'name' | 'price-asc' | 'price-desc' | 'ordered';
export type SizeFilterMode = 'any' | 'all';

export interface CartLine {
  itemId: string;
  model: string;
  color: string;
  size: string;
  qty: number;
  price: number | null;
  subtotal: number | null;
  notes: string;
}
