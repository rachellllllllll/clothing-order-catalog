import { normalizeText } from '../catalog/text';
import type { CatalogSource, ImageRef } from './types';

/** Shape returned by /api/catalog (see api/catalog.ts). */
export interface DriveCatalogResponse {
  excel: { name: string; modifiedTime: string };
  images: { id: string; name: string }[];
}

export class DriveNotConfiguredError extends Error {}

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

export async function loadDriveCatalog(): Promise<CatalogSource> {
  const res = await fetch('/api/catalog');
  // In plain `vite dev` there is no /api and the SPA fallback returns index.html.
  if (res.status === 404 || !(res.headers.get('content-type') || '').includes('application/json')) {
    throw new DriveNotConfiguredError('שרת הקטלוג אינו זמין.');
  }
  if (!res.ok) throw new Error('טעינת הקטלוג נכשלה: ' + (await readError(res)));

  const data = (await res.json()) as DriveCatalogResponse;

  const excelRes = await fetch('/api/excel?v=' + encodeURIComponent(data.excel.modifiedTime));
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
    version: 'drive:' + data.excel.name + ':' + data.excel.modifiedTime,
    images,
    dispose: () => {},
  };
}
