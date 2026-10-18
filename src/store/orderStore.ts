import { create } from 'zustand';
import { parseCatalog } from '../lib/catalog/parseCatalog';
import { filterGroups } from '../lib/catalog/selectors';
import type { Catalog, QtyMap, SizeFilterMode, SortMode } from '../lib/catalog/types';
import type { CatalogSource } from '../lib/source/types';
import { readFirstSheet } from '../lib/xlsx/xlsx';

export interface Status {
  message: string;
  isError: boolean;
}

export interface LightboxState {
  /** Model keys in the order they were visible in the catalog when the lightbox opened. */
  models: string[];
  index: number;
}

interface OrderState {
  status: Status;
  loading: boolean;
  source: CatalogSource | null;
  catalog: Catalog | null;
  qty: QtyMap;
  signer: string;
  activeColorByModel: Record<string, number>;
  search: string;
  sort: SortMode;
  sizeFilter: string[];
  sizeFilterMode: SizeFilterMode;
  cartOpen: boolean;
  lightbox: LightboxState | null;

  setStatus(message: string, isError?: boolean): void;
  loadSource(loader: () => Promise<CatalogSource>): Promise<boolean>;
  changeQty(itemId: string, size: string, delta: number): void;
  removeLine(itemId: string, size: string): void;
  clearAll(): void;
  setSigner(signer: string): void;
  setActiveColor(modelKey: string, index: number): void;
  setSearch(search: string): void;
  setSort(sort: SortMode): void;
  toggleSizeFilter(size: string): void;
  setSizeFilterMode(mode: SizeFilterMode): void;
  clearSizeFilter(): void;
  setCartOpen(open: boolean): void;
  openLightbox(modelKey: string): void;
  stepLightbox(delta: number): void;
  setLightboxIndex(index: number): void;
  closeLightbox(): void;
}

const SIGNER_KEY = 'orderUi:signer';
const draftKey = (version: string) => 'orderDraft:' + version;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable (private mode / quota) — the app still works without drafts.
  }
}

/** A saved draft for this catalog version wins; otherwise start from the quantities in the file. */
function initialQty(catalog: Catalog, version: string): QtyMap {
  const qty: QtyMap = {};
  const put = (id: string, size: string, n: unknown) => {
    if (typeof n === 'number' && n > 0) (qty[id] ??= {})[size] = Math.floor(n);
  };

  const raw = readStorage(draftKey(version));
  if (raw) {
    try {
      const saved = JSON.parse(raw) as QtyMap;
      for (const [id, sizes] of Object.entries(saved)) {
        if (!catalog.itemById.has(id)) continue;
        for (const s of catalog.columns.sizeCols) put(id, s.label, sizes[s.label]);
      }
      return qty;
    } catch (e) {
      console.warn('Draft parse failed', e);
    }
  }

  for (const item of catalog.items) {
    for (const [size, n] of Object.entries(item.initialQty)) put(item.id, size, n);
  }
  return qty;
}

function withQty(qty: QtyMap, itemId: string, size: string, value: number): QtyMap {
  const sizes = { ...qty[itemId] };
  if (value > 0) sizes[size] = value;
  else delete sizes[size];
  const next = { ...qty };
  if (Object.keys(sizes).length) next[itemId] = sizes;
  else delete next[itemId];
  return next;
}

export const useOrderStore = create<OrderState>()((set, get) => ({
  status: { message: '', isError: false },
  loading: false,
  source: null,
  catalog: null,
  qty: {},
  signer: readStorage(SIGNER_KEY) ?? '',
  activeColorByModel: {},
  search: '',
  sort: 'default',
  sizeFilter: [],
  sizeFilterMode: 'any',
  cartOpen: false,
  lightbox: null,

  setStatus: (message, isError = false) => set({ status: { message, isError } }),

  async loadSource(loader) {
    set({ loading: true });
    try {
      const source = await loader();
      const catalog = parseCatalog(await readFirstSheet(source.excelData));
      get().source?.dispose();

      const firstSignature = catalog.items.find((it) => it.signature)?.signature ?? '';
      set({
        source,
        catalog,
        qty: initialQty(catalog, source.version),
        signer: get().signer || firstSignature,
        activeColorByModel: {},
        sizeFilter: [],
        sizeFilterMode: 'any',
        lightbox: null,
        loading: false,
        status: {
          message:
            source.kind === 'local'
              ? `נטענה תיקייה: "${source.excelName}" | ${catalog.groups.length} דגמים | ${source.images.size} תמונות`
              : `${catalog.groups.length} דגמים בקטלוג`,
          isError: false,
        },
      });
      return true;
    } catch (err) {
      console.error(err);
      set({
        loading: false,
        status: { message: 'שגיאה בטעינת הקטלוג: ' + (err instanceof Error ? err.message : String(err)), isError: true },
      });
      return false;
    }
  },

  changeQty(itemId, size, delta) {
    const current = get().qty[itemId]?.[size] ?? 0;
    set({ qty: withQty(get().qty, itemId, size, Math.max(0, current + delta)) });
  },

  removeLine: (itemId, size) => set({ qty: withQty(get().qty, itemId, size, 0) }),

  clearAll: () => set({ qty: {} }),

  setSigner: (signer) => set({ signer }),

  setActiveColor: (modelKey, index) =>
    set({ activeColorByModel: { ...get().activeColorByModel, [modelKey]: index } }),

  setSearch: (search) => set({ search }),
  setSort: (sort) => set({ sort }),

  toggleSizeFilter(size) {
    const cur = get().sizeFilter;
    set({ sizeFilter: cur.includes(size) ? cur.filter((s) => s !== size) : [...cur, size] });
  },
  setSizeFilterMode: (sizeFilterMode) => set({ sizeFilterMode }),
  clearSizeFilter: () => set({ sizeFilter: [] }),

  setCartOpen: (cartOpen) => set({ cartOpen }),

  openLightbox(modelKey) {
    const s = get();
    if (!s.catalog) return;
    const visible = filterGroups(s.catalog.groups, s.qty, s).map((g) => g.key);
    const models = visible.length ? visible : s.catalog.groups.map((g) => g.key);
    set({ lightbox: { models, index: Math.max(0, models.indexOf(modelKey)) } });
  },

  stepLightbox(delta) {
    const lb = get().lightbox;
    if (!lb || !lb.models.length) return;
    const len = lb.models.length;
    set({ lightbox: { ...lb, index: (lb.index + delta + len) % len } });
  },

  setLightboxIndex(index) {
    const lb = get().lightbox;
    if (lb) set({ lightbox: { ...lb, index } });
  },

  closeLightbox: () => set({ lightbox: null }),
}));

// Persist the cart per catalog version, and the signer name globally.
useOrderStore.subscribe((s, prev) => {
  if (s.source && (s.qty !== prev.qty || s.source !== prev.source)) {
    writeStorage(draftKey(s.source.version), JSON.stringify(s.qty));
  }
  if (s.signer !== prev.signer) writeStorage(SIGNER_KEY, s.signer);
});
