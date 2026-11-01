/**
 * Rounds created on the admin page — the catalog is a JSON file edited there, instead of an Excel file:
 *   ORDERS_FOLDER_ID/
 *     קטלוג/            appProperties { kind: 'catalogRoot' } — shared "anyone with the link: viewer" (for the images)
 *       <round name>/   appProperties { kind: 'round', draft: '1' | '0' }
 *         catalog.json  appProperties { kind: 'catalog', rev }  — a CatalogDoc
 *         <image>       appProperties { kind: 'image' }
 * Everything under קטלוג/ is readable by anyone with a link, so only catalog data goes there — never orders or members.
 */
import { HttpError } from './_drive.js';
import {
  createBinaryFile,
  createFolder,
  createJsonFile,
  findFiles,
  FOLDER_MIME,
  ordersRootId,
  q,
  readJson,
  renameFile,
  shareWithAnyone,
  trashFile,
  updateJsonFile,
  updateProperties,
  type AppFile,
} from './_google.js';
import type { CatalogDoc, DocCatalogResponse, DocColor, DocProduct, ImageUrls } from './_types.js';

const ROOT_NAME = 'קטלוג';
const CATALOG_FILE = 'catalog.json';
const MAX_PRODUCTS = 1000;
const MAX_SIZES = 80;
const MAX_COLORS = 40;
const MAX_NAME = 80;
export const MAX_IMAGE_BYTES = 3_000_000;
/** Unused images are trashed on save only once they are this old (one may be uploading while saving). */
const ORPHAN_IMAGE_MS = 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

// ── Catalog document ──

/** Same as normalizeText on the client: models are unique by this key, and images are matched by it. */
export function modelKey(v: string): string {
  return v.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const sizeKey = (s: string) => s.trim().toUpperCase();

function badCatalog(what: string): HttpError {
  return new HttpError(400, 'קטלוג לא תקין: ' + what + '.', 'bad_catalog');
}

function text(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string' || v.length > max) throw badCatalog(what);
  return v.trim();
}

export function parseSizes(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_SIZES) throw badCatalog('מידות');
  const sizes: string[] = [];
  for (const s of raw) {
    const label = text(s, 20, 'מידה');
    if (!label) throw badCatalog('מידה ריקה');
    if (sizes.some((x) => sizeKey(x) === sizeKey(label))) throw badCatalog('מידה כפולה ' + label);
    sizes.push(label);
  }
  return sizes;
}

/**
 * Validates a catalog sent by the admin page. Products may still be incomplete (a draft is saved as it is);
 * `publishProblems` checks what orderers need. Image ids that aren't images of the round are dropped.
 */
export function parseCatalogDoc(raw: unknown, imageIds: ReadonlySet<string>): CatalogDoc {
  const o = raw as Partial<CatalogDoc> | null;
  if (!o || typeof o !== 'object' || o.v !== 1) throw badCatalog('גרסה');
  const sizes = parseSizes(o.sizes);
  if (!Array.isArray(o.products) || o.products.length > MAX_PRODUCTS) throw badCatalog('מוצרים');
  const ids = new Set<string>();
  const models = new Set<string>();
  const products = (o.products as Partial<DocProduct>[]).map((p): DocProduct => {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !ID_RE.test(p.id) || ids.has(p.id)) {
      throw badCatalog('מזהה מוצר');
    }
    ids.add(p.id);
    const model = text(p.model, 120, 'דגם');
    const key = modelKey(model);
    if (key) {
      if (models.has(key)) throw badCatalog('הדגם "' + model + '" מופיע פעמיים');
      models.add(key);
    }
    const price = p.price;
    if (price !== null && !(typeof price === 'number' && Number.isFinite(price) && price >= 0 && price <= 1_000_000)) {
      throw badCatalog('מחיר של ' + (model || 'מוצר'));
    }
    if (!Array.isArray(p.sizes)) throw badCatalog('מידות של ' + (model || 'מוצר'));
    const chosen = new Set(p.sizes.filter((s): s is string => typeof s === 'string'));
    if (!Array.isArray(p.colors) || !p.colors.length || p.colors.length > MAX_COLORS) {
      throw badCatalog('צבעים של ' + (model || 'מוצר'));
    }
    const colorIds = new Set<string>();
    const colors = (p.colors as Partial<DocColor>[]).map((c): DocColor => {
      if (!c || typeof c.id !== 'string' || !ID_RE.test(c.id) || colorIds.has(c.id)) throw badCatalog('מזהה צבע');
      colorIds.add(c.id);
      return { id: c.id, name: text(c.name, 60, 'צבע') };
    });
    return {
      id: p.id,
      model,
      price: price ?? null,
      notes: text(p.notes ?? '', 500, 'הערות'),
      sizes: sizes.filter((s) => chosen.has(s)),
      colors,
      image: typeof p.image === 'string' && imageIds.has(p.image) ? p.image : null,
    };
  });
  return { v: 1, sizes, products };
}

/** What still has to be filled in before orderers can see the round. */
export function publishProblems(doc: CatalogDoc): string[] {
  const problems: string[] = [];
  if (!doc.products.length) problems.push('אין מוצרים בקטלוג.');
  const noModel = doc.products.filter((p) => !p.model).length;
  if (noModel) problems.push(`${noModel} מוצרים בלי שם דגם.`);
  const noSizes = doc.products.filter((p) => !p.sizes.length).map((p) => p.model || '?');
  if (noSizes.length) problems.push('בלי מידות: ' + noSizes.slice(0, 5).join(', ') + (noSizes.length > 5 ? '…' : '') + '.');
  return problems;
}

// ── Folders ──

async function findCatalogRoot(): Promise<AppFile | null> {
  const files = await findFiles(
    `${q(ordersRootId())} in parents and mimeType = ${q(FOLDER_MIME)} and trashed = false and ` +
      `appProperties has { key='kind' and value='catalogRoot' }`,
  );
  return files[0] ?? null;
}

async function ensureCatalogRoot(): Promise<AppFile> {
  const root = (await findCatalogRoot()) ?? (await createFolder(ROOT_NAME, ordersRootId(), { kind: 'catalogRoot' }));
  // Repeated on every new round: it does nothing when shared already, and restores the link if it was removed in Drive.
  await shareWithAnyone(root.id);
  return root;
}

export async function listAppRounds(): Promise<AppFile[]> {
  const root = await findCatalogRoot();
  if (!root) return [];
  return findFiles(
    `${q(root.id)} in parents and mimeType = ${q(FOLDER_MIME)} and trashed = false and ` +
      `appProperties has { key='kind' and value='round' }`,
  );
}

function roundName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > MAX_NAME) throw new HttpError(400, 'שם הסבב חסר או ארוך מדי.', 'bad_name');
  return name;
}

/** A new round starts as a draft with an empty catalog. */
export async function createAppRound(rawName: unknown, rawSizes: unknown): Promise<AppFile> {
  const name = roundName(rawName);
  const doc: CatalogDoc = { v: 1, sizes: parseSizes(rawSizes), products: [] };
  const root = await ensureCatalogRoot();
  const folder = await createFolder(name, root.id, { kind: 'round', draft: '1' });
  await createJsonFile(folder.id, CATALOG_FILE, { kind: 'catalog', rev: '1' }, doc);
  return folder;
}

// ── Catalog and images ──

async function catalogFile(folderId: string): Promise<AppFile | null> {
  const files = await findFiles(
    `${q(folderId)} in parents and trashed = false and appProperties has { key='kind' and value='catalog' }`,
  );
  return files[0] ?? null;
}

function imageFiles(folderId: string): Promise<AppFile[]> {
  return findFiles(`${q(folderId)} in parents and trashed = false and appProperties has { key='kind' and value='image' }`);
}

export function imageUrls(id: string): ImageUrls {
  const fake = process.env.FAKE_IMAGE_BASE; // dev server with the in-memory Drive
  if (fake) return { thumb: fake + encodeURIComponent(id), full: fake + encodeURIComponent(id) };
  const url = (w: number) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${w}`;
  return { thumb: url(600), full: url(2000) };
}

async function loadDoc(folder: AppFile): Promise<{ doc: CatalogDoc; rev: number; file: AppFile | null; images: AppFile[] }> {
  const [file, images] = await Promise.all([catalogFile(folder.id), imageFiles(folder.id)]);
  const ids = new Set(images.map((f) => f.id));
  const doc = file ? parseCatalogDoc(await readJson(file.id), ids) : { v: 1 as const, sizes: [], products: [] };
  return { doc, rev: Number(file?.appProperties.rev) || 0, file, images };
}

export async function readAppCatalog(folder: AppFile): Promise<DocCatalogResponse & { rev: number }> {
  const { doc, rev } = await loadDoc(folder);
  const images: Record<string, ImageUrls> = {};
  for (const p of doc.products) if (p.image) images[p.image] = imageUrls(p.image);
  return { round: { id: folder.id, name: folder.name }, catalog: doc, images, rev };
}

/** Saves the catalog edited on the admin page; `rev` must be the revision it was loaded with. */
export async function saveAppCatalog(
  folder: AppFile,
  raw: unknown,
  rev: unknown,
  rawName: unknown,
): Promise<{ rev: number; name: string }> {
  const name = rawName === undefined ? folder.name : roundName(rawName);
  const current = await loadDoc(folder);
  if (rev !== current.rev) {
    throw new HttpError(409, 'הקטלוג נשמר בינתיים מחלון אחר — טענו אותו מחדש.', 'conflict');
  }
  const doc = parseCatalogDoc(raw, new Set(current.images.map((f) => f.id)));
  const next = current.rev + 1;
  if (current.file) await updateJsonFile(current.file.id, { kind: 'catalog', rev: String(next) }, doc);
  else await createJsonFile(folder.id, CATALOG_FILE, { kind: 'catalog', rev: String(next) }, doc);
  if (name !== folder.name) await renameFile(folder.id, name);

  // Images no product uses any more (replaced, or their product was removed) go to the Drive trash.
  const used = new Set(doc.products.map((p) => p.image));
  const old = Date.now() - ORPHAN_IMAGE_MS;
  const orphans = current.images.filter((f) => !used.has(f.id) && Date.parse(f.createdTime) < old);
  await Promise.all(orphans.map((f) => trashFile(f.id)));
  return { rev: next, name };
}

function imageType(b: Uint8Array): { mime: string; ext: string } | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

/** Stores a product image (base64) in the round folder; it is used once a saved catalog refers to it. */
export async function uploadImage(folder: AppFile, data: unknown): Promise<{ id: string } & ImageUrls> {
  if (typeof data !== 'string' || !data || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new HttpError(413, 'התמונה גדולה מדי.', 'too_large');
  }
  const bytes = Buffer.from(data, 'base64');
  const type = imageType(bytes);
  if (!type) throw new HttpError(415, 'אפשר להעלות רק תמונות JPEG, PNG או WebP.', 'bad_image');
  const file = await createBinaryFile(folder.id, `image-${Date.now()}.${type.ext}`, type.mime, { kind: 'image' }, bytes);
  return { id: file.id, ...imageUrls(file.id) };
}

/** Shows the round to orderers, once the catalog is complete enough. */
export async function publishAppRound(folder: AppFile): Promise<void> {
  const problems = publishProblems((await loadDoc(folder)).doc);
  if (problems.length) {
    throw new HttpError(409, 'אי אפשר לפרסם עדיין: ' + problems.join(' '), 'incomplete', { problems });
  }
  await updateProperties(folder.id, { draft: '0' });
}
