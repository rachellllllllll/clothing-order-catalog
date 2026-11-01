import type { DocCatalogResponse } from '../../../api/_types';
import { apiPost } from '../api/client';
import { catalogFromDoc } from '../catalog/catalogDoc';
import { parseCatalog } from '../catalog/parseCatalog';
import { normalizeText } from '../catalog/text';
import { readFirstSheet } from '../xlsx/xlsx';
import type { CatalogSource, ImageRef, Round } from './types';

/** Shape returned by /api/catalog (see api/catalog.ts) for a round folder with an Excel file. */
export interface DriveCatalogResponse {
  round: { id: string; name: string };
  excel: { name: string; modifiedTime: string };
  images: { id: string; name: string }[];
}

export class DriveNotConfiguredError extends Error {}

/** Keyed by folder id, not name: renaming a round folder keeps the saved drafts. */
export function driveCatalogKey(roundId: string): string {
  return 'drive:' + roundId;
}

function driveImage(id: string, width: number): string {
  return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w' + width;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error || res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function loadDriveRounds(): Promise<Round[]> {
  // no-cache: the browser must not reuse a stale copy (lock/archive state); the CDN copy is short-lived.
  const res = await fetch('/api/rounds', { cache: 'no-cache' });
  // In plain `vite dev` there is no /api and the SPA fallback returns index.html.
  if (res.status === 404 || !(res.headers.get('content-type') || '').includes('application/json')) {
    throw new DriveNotConfiguredError('שרת הקטלוג אינו זמין.');
  }
  if (!res.ok) throw new Error('טעינת סבבי ההזמנה נכשלה: ' + (await readError(res)));
  return ((await res.json()) as { rounds: Round[] }).rounds;
}

/** A round edited on the admin page: the catalog is JSON, with one image per product. */
export function docCatalogSource(data: DocCatalogResponse): CatalogSource {
  const catalog = catalogFromDoc(data.catalog);
  const images = new Map<string, ImageRef>();
  for (const p of data.catalog.products) {
    const urls = p.image ? data.images[p.image] : undefined;
    if (urls && p.model.trim()) images.set(normalizeText(p.model), urls);
  }
  return {
    kind: 'drive',
    excelName: data.round.name,
    excelData: null,
    catalog,
    catalogKey: driveCatalogKey(data.round.id),
    images,
    dispose: () => {},
  };
}

/** `admin`: rounds edited on the admin page load uncached through the admin API (drafts included). */
export async function loadDriveCatalog(round: Round, opts: { admin?: boolean } = {}): Promise<CatalogSource> {
  if (round.editable && opts.admin) {
    return docCatalogSource(await apiPost<DocCatalogResponse>('/api/admin', { action: 'catalog', round: round.id }));
  }
  const roundParam = 'round=' + encodeURIComponent(round.id);
  const res = await fetch('/api/catalog?' + roundParam);
  if (!res.ok) throw new Error('טעינת הקטלוג נכשלה: ' + (await readError(res)));

  const body = (await res.json()) as DriveCatalogResponse | DocCatalogResponse;
  if ('catalog' in body) return docCatalogSource(body);
  const data = body;

  const excelRes = await fetch('/api/excel?' + roundParam + '&v=' + encodeURIComponent(data.excel.modifiedTime));
  if (!excelRes.ok) throw new Error('הורדת קובץ האקסל נכשלה: ' + (await readError(excelRes)));
  const excelData = await excelRes.arrayBuffer();

  const images = new Map<string, ImageRef>();
  for (const img of data.images) {
    images.set(normalizeText(img.name.replace(/\.[^.]+$/, '')), {
      thumb: driveImage(img.id, 600),
      full: driveImage(img.id, 2000),
    });
  }

  return {
    kind: 'drive',
    excelName: data.excel.name,
    excelData,
    catalog: parseCatalog(await readFirstSheet(excelData)),
    catalogKey: driveCatalogKey(data.round.id),
    images,
    dispose: () => {},
  };
}
