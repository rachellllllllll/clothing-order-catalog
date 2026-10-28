import { normalizeText } from '../catalog/text';
import type { CatalogSource, ImageRef, Round } from './types';

/** Shape returned by /api/catalog (see api/catalog.ts). */
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

export async function loadDriveCatalog(round: Round): Promise<CatalogSource> {
  const roundParam = 'round=' + encodeURIComponent(round.id);
  const res = await fetch('/api/catalog?' + roundParam);
  if (!res.ok) throw new Error('טעינת הקטלוג נכשלה: ' + (await readError(res)));

  const data = (await res.json()) as DriveCatalogResponse;

  const excelRes = await fetch('/api/excel?' + roundParam + '&v=' + encodeURIComponent(data.excel.modifiedTime));
  if (!excelRes.ok) throw new Error('הורדת קובץ האקסל נכשלה: ' + (await readError(excelRes)));

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
    excelData: await excelRes.arrayBuffer(),
    catalogKey: driveCatalogKey(data.round.id),
    images,
    dispose: () => {},
  };
}
