import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogDoc, DocCatalogResponse, DocProduct, ImageUrls, OrderDto } from '../../api/_types';
import { ApiError, apiPost } from '../lib/api/client';
import { docItemId, newId } from '../lib/catalog/catalogDoc';
import { formatSavedAt, normalizeText } from '../lib/catalog/text';
import type { Round } from '../lib/source/types';
import { SizesEditor } from './SizesEditor';

/** Set while the catalog editor has unsaved changes (checked before leaving the round). */
export const unsavedCatalog = { current: false };

/** Images are scaled down in the browser before upload (Drive serves smaller thumbnails anyway). */
const MAX_SIDE = 1600;
const UPLOAD_CONCURRENCY = 3;
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isImage = (f: File) => /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);

const BACKUP_KEY = 'orderUi:catalogBackup:';

/**
 * Unsaved changes, kept on this device until they are saved: they survive a closed tab, a reload, leaving the
 * round, or an admin session that expired in the middle of the work.
 */
interface Backup {
  /** The catalog revision the changes were made on. */
  rev: number;
  name: string;
  doc: CatalogDoc;
  at: string;
}

function readBackup(roundId: string): Backup | null {
  try {
    const b = JSON.parse(localStorage.getItem(BACKUP_KEY + roundId) ?? 'null') as Partial<Backup> | null;
    const ok =
      !!b &&
      typeof b.rev === 'number' &&
      typeof b.name === 'string' &&
      typeof b.at === 'string' &&
      b.doc?.v === 1 &&
      Array.isArray(b.doc.sizes) &&
      Array.isArray(b.doc.products);
    return ok ? (b as Backup) : null;
  } catch {
    return null;
  }
}

function writeBackup(roundId: string, backup: Backup | null) {
  try {
    if (backup) localStorage.setItem(BACKUP_KEY + roundId, JSON.stringify(backup));
    else localStorage.removeItem(BACKUP_KEY + roundId);
  } catch {
    // Storage full or blocked: only the copy in the page is kept.
  }
}

/** Adds the urls of images that were uploaded but never saved in the catalog (a restored backup may use them). */
function withImages(images: Record<string, ImageUrls>, doc: CatalogDoc): Record<string, ImageUrls> {
  const out = { ...images };
  for (const p of doc.products) {
    if (p.image && !out[p.image]) {
      const url = '/api/image?id=' + encodeURIComponent(p.image);
      out[p.image] = { thumb: url, full: url };
    }
  }
  return out;
}

async function prepareImage(file: File): Promise<{ base64: string; blob: Blob }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('לא ניתן לקרוא את התמונה ' + file.name);
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // transparent PNGs become JPEG on white
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('הכנת התמונה נכשלה.'))), 'image/jpeg', 0.85),
  );
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('הכנת התמונה נכשלה.'));
    reader.readAsDataURL(blob);
  });
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), blob };
}

async function runPool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

/** Trimmed text, and product sizes in the round's order — what is sent and stored. */
function cleanDoc(doc: CatalogDoc): CatalogDoc {
  return {
    ...doc,
    products: doc.products.map((p) => ({
      ...p,
      model: p.model.trim(),
      notes: p.notes.trim(),
      sizes: doc.sizes.filter((s) => p.sizes.includes(s)),
      colors: p.colors.map((c) => ({ ...c, name: c.name.trim() })),
    })),
  };
}

interface CatalogEditorProps {
  round: Round;
  /** Kept mounted (with its unsaved changes) while another tab is shown. */
  hidden: boolean;
  /** The round's orders: ordered products, colors and sizes can't be removed. */
  orders: Map<string, OrderDto> | null;
  onSaved: (name: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSignedOut: () => void;
}

/** Products, prices, sizes and images of a round created on the admin page. */
export function CatalogEditor({ round, hidden, orders, onSaved, onDirtyChange, onSignedOut }: CatalogEditorProps) {
  const [doc, setDoc] = useState<CatalogDoc | null>(null);
  const [saved, setSaved] = useState<{ rev: number; json: string; name: string } | null>(null);
  const [name, setName] = useState(round.name);
  const [images, setImages] = useState<Record<string, ImageUrls>>({});
  const [uploads, setUploads] = useState<Record<string, 'busy' | 'error'>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkPrice, setBulkPrice] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: '' });
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Unsaved changes found on this device when the catalog loaded: applied, or (saved elsewhere since) only offered.
  const [restored, setRestored] = useState<{ backup: Backup; applied: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);
  const lastSizeClick = useRef<{ product: string; index: number } | null>(null);
  const objectUrls = useRef<string[]>([]);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setStatus({ text: errText(err), error: true });
    },
    [onSignedOut],
  );

  const load = useCallback(async () => {
    try {
      const res = await apiPost<DocCatalogResponse & { rev: number }>('/api/admin', { action: 'catalog', round: round.id });
      const json = JSON.stringify(res.catalog);
      const backup = readBackup(round.id);
      const pending = backup && (JSON.stringify(backup.doc) !== json || backup.name !== res.round.name) ? backup : null;
      const apply = !!pending && pending.rev === res.rev;
      setDoc(apply ? pending.doc : res.catalog);
      setImages(apply ? withImages(res.images, pending.doc) : res.images);
      setName(apply ? pending.name : res.round.name);
      setSaved({ rev: res.rev, json, name: res.round.name });
      setRestored(pending && { backup: pending, applied: apply });
      setSelected(new Set());
      setConflict(false);
      setStatus({ text: '' });
    } catch (err) {
      fail(err);
    }
  }, [round.id, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => objectUrls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const docJson = useMemo(() => (doc ? JSON.stringify(doc) : ''), [doc]);
  const dirty = !!doc && !!saved && (docJson !== saved.json || name.trim() !== saved.name);

  useEffect(() => {
    unsavedCatalog.current = dirty;
    onDirtyChange(dirty);
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => void (unsavedCatalog.current = false), []);

  // While a backup from before is only offered, it stays as it is until the admin chooses.
  useEffect(() => {
    if (!doc || !saved || (restored && !restored.applied)) return;
    const untouched = restored && doc === restored.backup.doc && name === restored.backup.name;
    const at = untouched ? restored.backup.at : new Date().toISOString();
    writeBackup(round.id, dirty ? { rev: saved.rev, name, doc, at } : null);
  }, [round.id, doc, name, saved, dirty, restored]);

  function applyBackup() {
    if (!restored) return;
    const { backup } = restored;
    setDoc(backup.doc);
    setName(backup.name);
    setImages((m) => withImages(m, backup.doc));
    setRestored({ backup, applied: true });
  }

  function discardBackup() {
    if (!saved || !restored) return;
    if (restored.applied) {
      if (!window.confirm('למחוק את השינויים שלא נשמרו ולחזור למה שנשמר?')) return;
      setDoc(JSON.parse(saved.json) as CatalogDoc);
      setName(saved.name);
    }
    setRestored(null);
  }

  // What was ordered (in drafts or sent orders): such items and sizes stay, so no order line loses its product.
  const ordered = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const o of orders?.values() ?? []) {
      for (const l of [...o.lines, ...(o.submitted?.lines ?? [])]) {
        let sizes = map.get(l.id);
        if (!sizes) map.set(l.id, (sizes = new Set()));
        sizes.add(l.size);
      }
    }
    return map;
  }, [orders]);
  const orderedSizes = useMemo(() => new Set([...ordered.values()].flatMap((s) => [...s])), [ordered]);
  const productOrdered = (p: DocProduct) => p.colors.some((c) => ordered.has(docItemId(p, c.id)));
  const sizeOrderedIn = (p: DocProduct, size: string) => p.colors.some((c) => ordered.get(docItemId(p, c.id))?.has(size));

  const modelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of doc?.products ?? []) {
      const k = normalizeText(p.model);
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }, [doc]);

  const update = (id: string, patch: (p: DocProduct) => Partial<DocProduct>) =>
    setDoc((d) => d && { ...d, products: d.products.map((p) => (p.id === id ? { ...p, ...patch(p) } : p)) });

  const setUpload = (id: string, state: 'busy' | 'error' | null) =>
    setUploads((u) => {
      const next = { ...u };
      if (state) next[id] = state;
      else delete next[id];
      return next;
    });

  async function uploadFor(productId: string, file: File) {
    setUpload(productId, 'busy');
    try {
      const { base64, blob } = await prepareImage(file);
      const res = await apiPost<{ id: string } & ImageUrls>('/api/admin', { action: 'uploadImage', round: round.id, data: base64 });
      // The local copy shows right away (Drive needs a moment to make thumbnails of a new file).
      const url = URL.createObjectURL(blob);
      objectUrls.current.push(url);
      setImages((m) => ({ ...m, [res.id]: { thumb: url, full: url } }));
      update(productId, () => ({ image: res.id }));
      setUpload(productId, null);
    } catch (err) {
      setUpload(productId, 'error');
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setStatus({ text: 'העלאת ' + file.name + ' נכשלה: ' + errText(err), error: true });
    }
  }

  /** Each image becomes a new product named after its file (in every size of the round). */
  function addImages(files: File[]) {
    if (!doc) return;
    const imgs = files.filter(isImage).sort((a, b) => a.name.localeCompare(b.name, 'he', { numeric: true }));
    if (!imgs.length) {
      setStatus({ text: 'לא נמצאו תמונות JPEG, PNG או WebP.', error: true });
      return;
    }
    const taken = new Set(doc.products.map((p) => normalizeText(p.model)));
    const created = imgs.map((file) => {
      const base = file.name.replace(/\.[^.]+$/, '').trim() || 'מוצר';
      let model = base;
      for (let n = 2; taken.has(normalizeText(model)); n++) model = `${base} (${n})`;
      taken.add(normalizeText(model));
      const product: DocProduct = {
        id: newId(),
        model,
        price: null,
        notes: '',
        sizes: [...doc.sizes],
        colors: [{ id: newId(), name: '' }],
        image: null,
      };
      return { file, product };
    });
    setDoc((d) => d && { ...d, products: [...d.products, ...created.map((c) => c.product)] });
    setStatus({ text: `נוספו ${created.length} מוצרים — השלימו שם דגם, מחיר ומידות.` });
    void runPool(created, UPLOAD_CONCURRENCY, (c) => uploadFor(c.product.id, c.file));
  }

  function addEmptyProduct() {
    if (!doc) return;
    const product: DocProduct = {
      id: newId(),
      model: '',
      price: null,
      notes: '',
      sizes: [...doc.sizes],
      colors: [{ id: newId(), name: '' }],
      image: null,
    };
    setDoc({ ...doc, products: [...doc.products, product] });
  }

  function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    const target = replaceTarget.current;
    replaceTarget.current = null;
    if (target) {
      if (files[0] && isImage(files[0])) void uploadFor(target, files[0]);
    } else addImages(files);
  }

  function pickFiles(replaceFor: string | null) {
    replaceTarget.current = replaceFor;
    const input = fileInput.current;
    if (!input) return;
    input.multiple = !replaceFor;
    input.click();
  }

  function removeProducts(ids: ReadonlySet<string>) {
    if (!doc) return;
    const removable = doc.products.filter((p) => ids.has(p.id) && !productOrdered(p));
    if (!removable.length) return;
    const names = removable.map((p) => p.model || 'ללא שם');
    const question =
      removable.length === 1 ? `להסיר את "${names[0]}" מהקטלוג?` : `להסיר ${removable.length} מוצרים מהקטלוג?`;
    if (!window.confirm(question)) return;
    const gone = new Set(removable.map((p) => p.id));
    setDoc({ ...doc, products: doc.products.filter((p) => !gone.has(p.id)) });
    setSelected((s) => new Set([...s].filter((id) => !gone.has(id))));
  }

  function setRoundSizes(sizes: string[]) {
    setDoc((d) => d && { ...d, sizes, products: d.products.map((p) => ({ ...p, sizes: p.sizes.filter((s) => sizes.includes(s)) })) });
  }

  /** Click toggles a size; shift-click sets the whole run from the previous click to the same state. */
  function clickSize(p: DocProduct, index: number, shift: boolean) {
    if (!doc) return;
    const size = doc.sizes[index];
    const on = !p.sizes.includes(size);
    const last = lastSizeClick.current;
    const run =
      shift && last && last.product === p.id
        ? doc.sizes.slice(Math.min(last.index, index), Math.max(last.index, index) + 1)
        : [size];
    lastSizeClick.current = { product: p.id, index };
    const keep = run.filter((s) => !on && sizeOrderedIn(p, s));
    if (keep.length) setStatus({ text: `המידות ${keep.join(', ')} של ${p.model} הוזמנו — הן נשארות.`, error: true });
    const change = new Set(run.filter((s) => !keep.includes(s)));
    update(p.id, (cur) => ({
      sizes: doc.sizes.filter((s) => (change.has(s) ? on : cur.sizes.includes(s))),
    }));
  }

  function toggleAllSizes(p: DocProduct) {
    if (!doc) return;
    const all = p.sizes.length === doc.sizes.length;
    update(p.id, () => ({ sizes: all ? doc.sizes.filter((s) => sizeOrderedIn(p, s)) : [...doc.sizes] }));
  }

  function addColors(p: DocProduct, text: string) {
    const names = text.split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    update(p.id, (cur) => {
      const colors = cur.colors.filter((c) => c.name); // a product without colors keeps its item id for the first color
      const unnamed = cur.colors.find((c) => !c.name);
      for (const name of names) {
        if (colors.some((c) => normalizeText(c.name) === normalizeText(name))) continue;
        colors.push({ id: !colors.length && unnamed ? unnamed.id : newId(), name });
      }
      return { colors };
    });
  }

  function removeColor(p: DocProduct, colorId: string) {
    update(p.id, (cur) => {
      const colors = cur.colors.filter((c) => c.id !== colorId);
      return { colors: colors.length ? colors : [{ id: colorId, name: '' }] };
    });
  }

  function renameColor(p: DocProduct, colorId: string, current: string) {
    const next = window.prompt('שם הצבע', current)?.trim();
    if (!next || next === current) return;
    update(p.id, (cur) => ({ colors: cur.colors.map((c) => (c.id === colorId ? { ...c, name: next } : c)) }));
  }

  function applyBulkPrice() {
    const price = Number(bulkPrice);
    if (bulkPrice.trim() === '' || !Number.isFinite(price) || price < 0) return;
    setDoc((d) => d && { ...d, products: d.products.map((p) => (selected.has(p.id) ? { ...p, price } : p)) });
    setBulkPrice('');
  }

  function bulkAllSizes() {
    setDoc((d) => d && { ...d, products: d.products.map((p) => (selected.has(p.id) ? { ...p, sizes: [...d.sizes] } : p)) });
  }

  const busyUploads = Object.values(uploads).filter((u) => u === 'busy').length;
  const duplicates = [...modelCounts.values()].some((n) => n > 1);
  const products = doc?.products ?? [];
  const noModel = products.filter((p) => !p.model.trim()).length;
  const noSizes = products.filter((p) => !p.sizes.length).length;
  const noPrice = products.filter((p) => p.price == null).length;
  const noImage = products.filter((p) => !p.image).length;
  const items = products.reduce((n, p) => n + p.colors.length, 0);

  let saveBlocked = '';
  if (busyUploads) saveBlocked = 'ממתין לסיום העלאת התמונות';
  else if (duplicates) saveBlocked = 'יש דגמים כפולים — שנו את השם של אחד מהם';
  else if (!name.trim()) saveBlocked = 'חסר שם לסבב';
  else if (!round.draft && (noModel || noSizes)) saveBlocked = 'הסבב פורסם: לכל מוצר צריך שם דגם ולפחות מידה אחת';

  async function save() {
    if (!doc || !saved || saving || !dirty || saveBlocked) return;
    const sent = doc;
    const clean = cleanDoc(sent);
    const sentName = name;
    setSaving(true);
    try {
      const res = await apiPost<{ rev: number; name: string }>('/api/admin', {
        action: 'saveCatalog',
        round: round.id,
        catalog: clean,
        rev: saved.rev,
        name: sentName.trim(),
      });
      setSaved({ rev: res.rev, json: JSON.stringify(clean), name: res.name });
      setDoc((d) => (d === sent ? clean : d));
      setName((n) => (n === sentName ? res.name : n));
      setRestored(null);
      setStatus({ text: 'הקטלוג נשמר.' });
      onSaved(res.name);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') setConflict(true);
      fail(err);
    } finally {
      setSaving(false);
    }
  }
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden]);

  if (!doc || !saved) {
    return (
      <div hidden={hidden} className={status.error ? 'status error' : 'muted'}>
        {status.text || 'טוען קטלוג…'}
      </div>
    );
  }

  const query = normalizeText(search);
  const visible = query ? products.filter((p) => normalizeText(p.model).includes(query)) : products;
  const allSelected = visible.length > 0 && visible.every((p) => selected.has(p.id));

  return (
    <div className="catalog-editor" hidden={hidden}>
      <div className="ce-head">
        <div className="field">
          <label htmlFor="ceRoundName">שם הסבב</label>
          <input id="ceRoundName" type="text" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="ce-save">
          <button
            type="button"
            className="btn-primary"
            disabled={!dirty || saving || !!saveBlocked}
            title={saveBlocked || 'Ctrl+S'}
            onClick={() => void save()}
          >
            {saving ? 'שומר…' : 'שמירה'}
          </button>
          {dirty ? (
            <span className="ce-dirty">● יש שינויים שלא נשמרו</span>
          ) : (
            <span className="muted small">כל השינויים נשמרו</span>
          )}
          {saveBlocked && dirty && <span className="small danger">{saveBlocked}</span>}
          {conflict && (
            <button type="button" className="btn-secondary btn-sm" onClick={() => void load()}>
              טעינה מחדש (השינויים כאן יימחקו)
            </button>
          )}
        </div>
      </div>
      {status.text && <div className={'status' + (status.error ? ' error' : '')}>{status.text}</div>}
      {restored && (
        <div className="status ce-restored">
          {restored.applied ? (
            <span>
              שוחזרו שינויים שלא נשמרו (שינוי אחרון {formatSavedAt(restored.backup.at)}) — הם עדיין לא נשמרו בשרת, לחצו "שמירה".
            </span>
          ) : (
            <>
              <span>
                יש במכשיר הזה שינויים שלא נשמרו (שינוי אחרון {formatSavedAt(restored.backup.at)}), אבל הקטלוג נשמר מאז ממקום
                אחר.
              </span>
              <button type="button" className="btn-secondary btn-sm" onClick={applyBackup}>
                שחזור (יחליף את מה שנשמר מאז)
              </button>
            </>
          )}
          <button type="button" className="btn-link" onClick={discardBackup}>
            {restored.applied ? 'ביטול השחזור' : 'מחיקת השינויים'}
          </button>
        </div>
      )}

      <h3 className="ce-title">מידות בסבב</h3>
      <SizesEditor
        sizes={doc.sizes}
        onChange={setRoundSizes}
        lockedReason={(s) => (orderedSizes.has(s) ? 'יש הזמנות במידה הזאת' : null)}
      />

      <h3 className="ce-title">מוצרים</h3>
      <div
        className={'ce-drop' + (dragOver ? ' over' : '')}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addImages(Array.from(e.dataTransfer.files));
        }}
      >
        <span>גררו לכאן תמונות — כל תמונה יוצרת מוצר בשם הקובץ.</span>
        <button type="button" className="btn-secondary btn-sm" onClick={() => pickFiles(null)}>
          בחירת תמונות…
        </button>
        <button type="button" className="btn-link" onClick={addEmptyProduct}>
          + מוצר בלי תמונה
        </button>
        {busyUploads > 0 && <span className="muted small">מעלה {busyUploads} תמונות…</span>}
      </div>
      <input ref={fileInput} type="file" accept={IMAGE_ACCEPT} hidden onChange={onFilesPicked} />

      <div className="ce-summary muted small">
        {products.length} מוצרים · {items} פריטים (דגם + צבע)
        {noPrice > 0 && <span className="warn-text"> · {noPrice} בלי מחיר</span>}
        {noImage > 0 && <span> · {noImage} בלי תמונה</span>}
        {noSizes > 0 && <span className="danger"> · {noSizes} בלי מידות</span>}
        {noModel > 0 && <span className="danger"> · {noModel} בלי שם דגם</span>}
      </div>

      {products.length > 0 && (
        <div className="ce-bulk">
          <input
            type="search"
            className="admin-search"
            placeholder="חיפוש דגם…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {selected.size > 0 && (
            <>
              <span className="chip">נבחרו {selected.size}</span>
              <input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                className="ce-price"
                placeholder="מחיר"
                onWheel={(e) => e.currentTarget.blur()}
                aria-label="מחיר לנבחרים"
                value={bulkPrice}
                onChange={(e) => setBulkPrice(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyBulkPrice()}
              />
              <button type="button" className="btn-secondary btn-sm" disabled={bulkPrice.trim() === ''} onClick={applyBulkPrice}>
                קביעת מחיר
              </button>
              <button type="button" className="btn-secondary btn-sm" onClick={bulkAllSizes}>
                כל המידות
              </button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => removeProducts(selected)}>
                🗑 הסרה
              </button>
              <button type="button" className="btn-link" onClick={() => setSelected(new Set())}>
                ביטול בחירה
              </button>
            </>
          )}
        </div>
      )}

      {products.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table ce-table">
            <thead>
              <tr>
                <th>
                  <label className="ce-all">
                    <input
                      type="checkbox"
                      aria-label="בחירת הכל"
                      checked={allSelected}
                      onChange={() =>
                        setSelected((s) => {
                          const next = new Set(s);
                          for (const p of visible) {
                            if (allSelected) next.delete(p.id);
                            else next.add(p.id);
                          }
                          return next;
                        })
                      }
                    />
                    <span className="ce-all-label">בחירת הכל</span>
                  </label>
                </th>
                <th>תמונה</th>
                <th>דגם</th>
                <th>צבעים</th>
                <th>מחיר ($)</th>
                <th>
                  מידות <span className="muted small">(Shift+לחיצה = טווח)</span>
                </th>
                <th>הערות</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => {
                const key = normalizeText(p.model);
                const dup = !!key && (modelCounts.get(key) ?? 0) > 1;
                const img = p.image ? images[p.image] : undefined;
                const up = uploads[p.id];
                const locked = productOrdered(p);
                return (
                  <tr key={p.id} className={selected.has(p.id) ? 'selected' : undefined}>
                    <td className="ce-c-sel">
                      <input
                        type="checkbox"
                        aria-label={'בחירת ' + (p.model || 'מוצר')}
                        checked={selected.has(p.id)}
                        onChange={() =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (next.has(p.id)) next.delete(p.id);
                            else next.add(p.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="ce-c-img">
                      <button
                        type="button"
                        className={'ce-img' + (up === 'error' ? ' error' : '')}
                        title={img ? 'החלפת התמונה (אפשר גם לגרור תמונה לכאן)' : 'הוספת תמונה'}
                        onClick={() => pickFiles(p.id)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const file = Array.from(e.dataTransfer.files).find(isImage);
                          if (file) void uploadFor(p.id, file);
                        }}
                      >
                        {up === 'busy' ? (
                          <span className="small muted">מעלה…</span>
                        ) : img ? (
                          <img src={img.thumb} alt="" loading="lazy" />
                        ) : (
                          <span className="small muted">{up === 'error' ? 'נכשל — נסו שוב' : '+ תמונה'}</span>
                        )}
                      </button>
                    </td>
                    <td className="ce-c-model">
                      {/* Wraps (and grows) so a long model name is seen in full; it stays one line of text. */}
                      <textarea
                        rows={1}
                        className={'ce-model' + (dup || !p.model.trim() ? ' invalid' : '')}
                        value={p.model}
                        maxLength={120}
                        placeholder="שם הדגם"
                        aria-label="שם הדגם"
                        title={dup ? 'הדגם הזה מופיע פעמיים' : undefined}
                        onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
                        onChange={(e) => update(p.id, () => ({ model: e.target.value.replace(/\s*[\r\n]+\s*/g, ' ') }))}
                      />
                    </td>
                    <td className="ce-c-colors">
                      <ColorsCell
                        product={p}
                        isOrdered={(colorId) => ordered.has(docItemId(p, colorId))}
                        onAdd={(text) => addColors(p, text)}
                        onRemove={(colorId) => removeColor(p, colorId)}
                        onRename={(colorId, current) => renameColor(p, colorId, current)}
                      />
                    </td>
                    <td className="ce-c-price">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        inputMode="decimal"
                        className={'ce-price' + (p.price == null ? ' missing' : '')}
                        onWheel={(e) => e.currentTarget.blur()}
                        value={p.price ?? ''}
                        placeholder="מחיר"
                        aria-label="מחיר ($)"
                        onChange={(e) =>
                          update(p.id, () => ({ price: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) }))
                        }
                      />
                    </td>
                    <td className="ce-c-sizes">
                      {doc.sizes.length ? (
                        <div className={'ce-sizes' + (p.sizes.length ? '' : ' invalid')}>
                          {doc.sizes.map((s, i) => (
                            <button
                              key={s}
                              type="button"
                              className="ce-size"
                              aria-pressed={p.sizes.includes(s)}
                              onClick={(e) => clickSize(p, i, e.shiftKey)}
                            >
                              {s}
                            </button>
                          ))}
                          <button type="button" className="btn-link small" onClick={() => toggleAllSizes(p)}>
                            {p.sizes.length === doc.sizes.length ? 'אף אחת' : 'הכל'}
                          </button>
                        </div>
                      ) : (
                        <span className="muted small">הוסיפו מידות לסבב (למעלה)</span>
                      )}
                    </td>
                    <td className="ce-c-notes">
                      <input
                        type="text"
                        className="ce-notes"
                        value={p.notes}
                        maxLength={500}
                        placeholder="הערות"
                        aria-label="הערות"
                        onChange={(e) => update(p.id, () => ({ notes: e.target.value }))}
                      />
                    </td>
                    <td className="ce-c-del">
                      <button
                        type="button"
                        className="btn-link"
                        disabled={locked}
                        title={locked ? 'יש הזמנות למוצר הזה — אי אפשר להסיר אותו' : 'הסרת המוצר'}
                        aria-label="הסרת המוצר"
                        onClick={() => removeProducts(new Set([p.id]))}
                      >
                        🗑
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface ColorsCellProps {
  product: DocProduct;
  isOrdered: (colorId: string) => boolean;
  onAdd: (text: string) => void;
  onRemove: (colorId: string) => void;
  onRename: (colorId: string, current: string) => void;
}

/** Color chips (double-click renames) and a field that adds comma-separated colors. Empty = no colors. */
function ColorsCell({ product, isOrdered, onAdd, onRemove, onRename }: ColorsCellProps) {
  const [text, setText] = useState('');
  const named = product.colors.filter((c) => c.name);
  const commit = () => {
    onAdd(text);
    setText('');
  };
  return (
    <div className="ce-colors">
      {named.map((c) => {
        const locked = isOrdered(c.id);
        return (
          <span key={c.id} className="chip ce-color" title="לחיצה כפולה לשינוי השם" onDoubleClick={() => onRename(c.id, c.name)}>
            <bdi>{c.name}</bdi>
            <button
              type="button"
              className="chip-x"
              disabled={locked}
              title={locked ? 'יש הזמנות בצבע הזה' : 'הסרת הצבע'}
              aria-label={'הסרת הצבע ' + c.name}
              onClick={() => onRemove(c.id)}
            >
              ×
            </button>
          </span>
        );
      })}
      <input
        type="text"
        value={text}
        placeholder={named.length ? '+ צבע' : 'צבעים (לא חובה)'}
        aria-label="הוספת צבעים"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() && commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}
