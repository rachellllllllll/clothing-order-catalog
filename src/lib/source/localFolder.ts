import { normalizeText } from '../catalog/text';
import { EXCEL_RE, type CatalogSource, type ImageRef } from './types';

/** Development/offline mode: a folder picked from disk that contains the Excel file and the images. */
export async function loadLocalFolder(files: File[]): Promise<CatalogSource> {
  const excel = files.find((f) => EXCEL_RE.test(f.name) && !f.name.startsWith('~$'));
  if (!excel) throw new Error('לא נמצא קובץ אקסל (.xlsx) בתיקייה שנבחרה.');

  const urls: string[] = [];
  const images = new Map<string, ImageRef>();
  for (const f of files) {
    // Some systems leave File.type empty, so fall back to the extension.
    if (!f.type.startsWith('image/') && !/\.(jpe?g|png|webp|gif|avif)$/i.test(f.name)) continue;
    const url = URL.createObjectURL(f);
    urls.push(url);
    images.set(normalizeText(f.name.replace(/\.[^.]+$/, '')), { thumb: url, full: url });
  }

  return {
    kind: 'local',
    excelName: excel.name,
    excelData: await excel.arrayBuffer(),
    catalogKey: 'local:' + excel.name,
    images,
    dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)),
  };
}
