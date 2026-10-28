import { create } from 'zustand';
import type { OrderDto, OrderLine, SubmittedDto } from '../../api/_types';
import { catalogFileLines, linesToQty, parseDraft, qtyToLines, type Draft, type DraftLine } from '../lib/catalog/draft';
import { parseCatalog } from '../lib/catalog/parseCatalog';
import { filterGroups } from '../lib/catalog/selectors';
import type { Catalog, QtyMap, SizeFilterMode, SortMode } from '../lib/catalog/types';
import type { CatalogSource, Round } from '../lib/source/types';
import { loadDriveCatalog, loadDriveRounds } from '../lib/source/drive';
import { readFirstSheet } from '../lib/xlsx/xlsx';

export interface Status {
  message: string;
  isError: boolean;
  /** Rendered bidi-isolated right after `message` (file names mix Latin text into the RTL line). */
  fileName?: string;
  /** Text shown after `fileName`. */
  after?: string;
}

export interface LightboxState {
  /** Model keys in the order they were visible in the catalog when the lightbox opened. */
  models: string[];
  index: number;
}

export interface RemovedLine {
  itemId: string;
  size: string;
  qty: number;
}

/** "You have an order you started" — shown after a saved draft was restored. */
export interface ResumeNotice {
  units: number;
  updatedAt: string;
}

/** Saved/imported lines that have no matching item or size in the current catalog. */
export interface MissingNotice {
  origin: 'draft' | 'file';
  lines: DraftLine[];
}

export interface SaveState {
  /** ISO time of the last successful draft save (or of the restored draft). */
  savedAt: string | null;
  failed: boolean;
}

/** The orderer signed in to the open Drive round (name + PIN). */
export interface Account {
  name: string;
  token: string;
}

/** Server copy of the signed-in order (see store/orderSync.ts). */
export interface SyncState {
  /** Server revision the shown lines are based on (sent back as `baseRev`). */
  rev: number;
  /** linesKey() of the lines stored on the server. */
  serverKey: string;
  submitted: SubmittedDto | null;
  status: 'idle' | 'saving' | 'saved' | 'error';
  /** Shown while status is 'error'. */
  error: string | null;
  /** Server time of the last saved change. */
  savedAt: string | null;
}

/** The order was changed elsewhere while this device has other unsaved changes — the user picks one. */
export interface Conflict {
  server: OrderDto;
  mine: OrderLine[];
}

export const INITIAL_SYNC: SyncState = {
  rev: 0,
  serverKey: '',
  submitted: null,
  status: 'idle',
  error: null,
  savedAt: null,
};

interface OrderState {
  status: Status;
  loading: boolean;
  /** Order rounds in the Drive folder; null until loaded (or in local-folder mode). */
  rounds: Round[] | null;
  /** The open Drive round; null on the round picker and in local-folder mode. */
  round: Round | null;
  source: CatalogSource | null;
  catalog: Catalog | null;
  qty: QtyMap;
  signer: string;
  activeColorByModel: Record<string, number>;
  search: string;
  sort: SortMode;
  sizeFilter: string[];
  sizeFilterMode: SizeFilterMode;
  onlyOrdered: boolean;
  cartOpen: boolean;
  lightbox: LightboxState | null;
  /** The last cart line removed, kept briefly so it can be undone. */
  lastRemoved: RemovedLine | null;
  resumeNotice: ResumeNotice | null;
  missingNotice: MissingNotice | null;
  save: SaveState;
  account: Account | null;
  /** True while a saved session is being checked after opening a round. */
  authPending: boolean;
  /** Message for the sign-in panel (e.g. "session expired"). */
  authNotice: string | null;
  sync: SyncState;
  conflict: Conflict | null;

  setStatus(message: string, isError?: boolean, file?: Pick<Status, 'fileName' | 'after'>): void;
  loadSource(loader: () => Promise<CatalogSource>): Promise<boolean>;
  loadRounds(): Promise<Round[]>;
  openRound(round: Round): Promise<boolean>;
  /** Back to the round picker. The draft is already saved, so nothing is lost. */
  closeRound(): void;
  importOrderFile(file: File): Promise<void>;
  changeQty(itemId: string, size: string, delta: number): void;
  setQty(itemId: string, size: string, value: number): void;
  removeLine(itemId: string, size: string): void;
  undoRemove(): void;
  dismissRemoved(): void;
  clearAll(): void;
  dismissResume(): void;
  startNewOrder(): void;
  dismissMissing(): void;
  setSigner(signer: string): void;
  setActiveColor(modelKey: string, index: number): void;
  setSearch(search: string): void;
  setSort(sort: SortMode): void;
  toggleSizeFilter(size: string): void;
  setSizeFilterMode(mode: SizeFilterMode): void;
  clearSizeFilter(): void;
  setOnlyOrdered(onlyOrdered: boolean): void;
  setCartOpen(open: boolean): void;
  openLightbox(modelKey: string): void;
  stepLightbox(delta: number): void;
  setLightboxIndex(index: number): void;
  closeLightbox(): void;
}

const SIGNER_KEY = 'orderUi:signer';
const draftKey = (catalogKey: string) => 'orderUi:draft:' + catalogKey;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // Storage may be unavailable (private mode / quota) — the app still works without drafts.
    return false;
  }
}

function unitsOf(qty: QtyMap): number {
  let n = 0;
  for (const sizes of Object.values(qty)) for (const q of Object.values(sizes)) n += q;
  return n;
}

/** Server orders keep a local backup per round + orderer, so unsaved edits survive going offline. */
export function backupKey(catalogKey: string, name: string): string {
  return draftKey(catalogKey + ':' + name.toLowerCase().replace(/\s+/g, ' ').trim());
}

export function readBackup(catalogKey: string, name: string): Draft | null {
  return parseDraft(readStorage(backupKey(catalogKey, name)));
}

export function writeBackup(catalogKey: string, name: string, draft: Draft): boolean {
  return writeStorage(backupKey(catalogKey, name), JSON.stringify(draft));
}

/** Locked and archived rounds are view-only. */
export function isReadOnly(s: Pick<OrderState, 'round'>): boolean {
  return !!s.round && (s.round.locked || s.round.archived);
}

export { readStorage, writeStorage, unitsOf };

/** A saved draft for this catalog wins; otherwise start from the quantities in the file. */
function restoreDraft(
  catalog: Catalog,
  catalogKey: string,
): Pick<OrderState, 'qty' | 'resumeNotice' | 'missingNotice' | 'save'> {
  const draft = parseDraft(readStorage(draftKey(catalogKey)));
  if (!draft) {
    return {
      qty: linesToQty(catalog, catalogFileLines(catalog)).qty,
      resumeNotice: null,
      missingNotice: null,
      save: { savedAt: null, failed: false },
    };
  }
  const { qty, missing } = linesToQty(catalog, draft.lines);
  const units = unitsOf(qty);
  return {
    qty,
    resumeNotice: units > 0 ? { units, updatedAt: draft.updatedAt } : null,
    missingNotice: missing.length ? { origin: 'draft', lines: missing } : null,
    save: { savedAt: draft.updatedAt, failed: false },
  };
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
  rounds: null,
  round: null,
  source: null,
  catalog: null,
  qty: {},
  signer: readStorage(SIGNER_KEY) ?? '',
  activeColorByModel: {},
  search: '',
  sort: 'default',
  sizeFilter: [],
  sizeFilterMode: 'any',
  onlyOrdered: false,
  cartOpen: false,
  lightbox: null,
  lastRemoved: null,
  resumeNotice: null,
  missingNotice: null,
  save: { savedAt: null, failed: false },
  account: null,
  authPending: false,
  authNotice: null,
  sync: INITIAL_SYNC,
  conflict: null,

  setStatus: (message, isError = false, file) => set({ status: { message, isError, ...file } }),

  async loadSource(loader) {
    set({ loading: true });
    try {
      const source = await loader();
      const catalog = parseCatalog(await readFirstSheet(source.excelData));
      get().source?.dispose();

      const firstSignature = catalog.items.find((it) => it.signature)?.signature ?? '';
      // Drive orders live on the server: they load after signing in (store/orderSync.ts).
      const order =
        source.kind === 'local'
          ? restoreDraft(catalog, source.catalogKey)
          : { qty: {}, resumeNotice: null, missingNotice: null, save: { savedAt: null, failed: false } };
      set({
        round: null, // openRound() sets it after a successful load
        source,
        catalog,
        ...order,
        signer: source.kind === 'local' ? get().signer || firstSignature : get().signer,
        account: null,
        authPending: false,
        authNotice: null,
        sync: INITIAL_SYNC,
        conflict: null,
        activeColorByModel: {},
        sizeFilter: [],
        sizeFilterMode: 'any',
        onlyOrdered: false,
        lightbox: null,
        lastRemoved: null,
        loading: false,
        status:
          source.kind === 'local'
            ? {
                message: 'נטענה תיקייה: ',
                fileName: source.excelName,
                after: ` | ${catalog.groups.length} דגמים | ${source.images.size} תמונות`,
                isError: false,
              }
            : { message: `${catalog.groups.length} דגמים בקטלוג`, isError: false },
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

  async loadRounds() {
    set({ loading: true });
    try {
      const rounds = await loadDriveRounds();
      set({ rounds, loading: false });
      return rounds;
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  async openRound(round) {
    const ok = await get().loadSource(() => loadDriveCatalog(round));
    if (ok) set({ round });
    return ok;
  },

  closeRound() {
    get().source?.dispose();
    set({
      round: null,
      source: null,
      catalog: null,
      qty: {},
      search: '',
      sizeFilter: [],
      onlyOrdered: false,
      cartOpen: false,
      lightbox: null,
      lastRemoved: null,
      resumeNotice: null,
      missingNotice: null,
      save: { savedAt: null, failed: false },
      account: null,
      authPending: false,
      authNotice: null,
      sync: INITIAL_SYNC,
      conflict: null,
      status: { message: '', isError: false },
    });
  },

  async importOrderFile(file) {
    const catalog = get().catalog;
    if (!catalog || isReadOnly(get())) return;
    try {
      const imported = parseCatalog(await readFirstSheet(await file.arrayBuffer()));
      const lines = catalogFileLines(imported);
      if (!lines.length) {
        set({ status: { message: 'לא נמצאו כמויות בקובץ ', fileName: file.name, isError: true } });
        return;
      }
      const { qty, missing } = linesToQty(catalog, lines);
      const fileSigner = imported.items.find((it) => it.signature)?.signature ?? '';
      set({
        qty,
        resumeNotice: null,
        missingNotice: missing.length ? { origin: 'file', lines: missing } : null,
        lastRemoved: null,
        signer: get().signer || fileSigner,
        status: {
          message: 'נטענה הזמנה מהקובץ ',
          fileName: file.name,
          after: ` | ${unitsOf(qty)} יחידות`,
          isError: false,
        },
      });
    } catch (err) {
      console.error(err);
      set({
        status: {
          message: 'שגיאה בטעינת קובץ ההזמנה: ' + (err instanceof Error ? err.message : String(err)),
          isError: true,
        },
      });
    }
  },

  changeQty(itemId, size, delta) {
    if (isReadOnly(get())) return;
    const current = get().qty[itemId]?.[size] ?? 0;
    set({ qty: withQty(get().qty, itemId, size, Math.max(0, current + delta)) });
  },

  setQty(itemId, size, value) {
    if (isReadOnly(get())) return;
    set({ qty: withQty(get().qty, itemId, size, Math.max(0, Math.floor(value))) });
  },

  removeLine(itemId, size) {
    const qty = get().qty[itemId]?.[size] ?? 0;
    if (qty <= 0 || isReadOnly(get())) return;
    set({ qty: withQty(get().qty, itemId, size, 0), lastRemoved: { itemId, size, qty } });
  },

  undoRemove() {
    const r = get().lastRemoved;
    if (r && !isReadOnly(get())) set({ qty: withQty(get().qty, r.itemId, r.size, r.qty), lastRemoved: null });
  },

  dismissRemoved: () => set({ lastRemoved: null }),

  clearAll() {
    if (!isReadOnly(get())) set({ qty: {}, lastRemoved: null });
  },

  dismissResume: () => set({ resumeNotice: null }),

  startNewOrder() {
    if (!isReadOnly(get())) set({ qty: {}, lastRemoved: null, resumeNotice: null, missingNotice: null });
  },

  dismissMissing: () => set({ missingNotice: null }),

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
  setOnlyOrdered: (onlyOrdered) => set({ onlyOrdered }),

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

// Persist the cart per local catalog (on edits only — loading a catalog must not bump `updatedAt`),
// and the signer name globally. Drive orders are saved by store/orderSync.ts.
useOrderStore.subscribe((s, prev) => {
  if (s.source?.kind === 'local' && s.catalog && s.source === prev.source && s.qty !== prev.qty) {
    const draft: Draft = { updatedAt: new Date().toISOString(), lines: qtyToLines(s.catalog, s.qty) };
    const ok = writeStorage(draftKey(s.source.catalogKey), JSON.stringify(draft));
    useOrderStore.setState({
      save: ok ? { savedAt: draft.updatedAt, failed: false } : { ...s.save, failed: true },
      // Editing the restored order answers the "continue?" question.
      resumeNotice: null,
    });
  }
  if (s.signer !== prev.signer) writeStorage(SIGNER_KEY, s.signer);
});
