/**
 * Shared Google Drive helpers for the Vercel functions.
 * Files starting with "_" are not exposed as routes by Vercel.
 *
 * Required environment variables (Vercel → Project → Settings → Environment Variables):
 *   GOOGLE_API_KEY   – API key with the Google Drive API enabled
 *   DRIVE_FOLDER_ID  – the shared catalog folder id (the part after /folders/ in the Drive link)
 * The folder must be shared as "Anyone with the link – Viewer".
 * Every subfolder of it is an order round, holding that round's Excel file and images.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  createdTime: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Machine-readable reason for the client (e.g. 'wrong_pin'). */
    public code?: string,
    /** Extra JSON fields merged into the error response. */
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function config(): { key: string; folderId: string } {
  const key = process.env.GOOGLE_API_KEY;
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!key || !folderId) throw new HttpError(500, 'Drive is not configured on the server.');
  if (!/^[\w-]+$/.test(folderId)) throw new HttpError(500, 'Invalid DRIVE_FOLDER_ID.');
  return { key, folderId };
}

async function driveFetch(url: URL): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) {
    // Never echo the request URL: it contains the API key.
    console.error('Drive API error', res.status, await res.text());
    throw new HttpError(502, 'Google Drive request failed (' + res.status + ').');
  }
  return res;
}

export async function listFolder(folderId: string): Promise<DriveFile[]> {
  const { key } = config();
  const files: DriveFile[] = [];
  let pageToken = '';
  do {
    const url = new URL(DRIVE_API);
    url.searchParams.set('q', `'${folderId}' in parents and trashed = false`);
    url.searchParams.set('fields', 'nextPageToken, files(id, name, mimeType, modifiedTime, createdTime)');
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('key', key);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const body = (await (await driveFetch(url)).json()) as { files: DriveFile[]; nextPageToken?: string };
    files.push(...body.files);
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return files;
}

/** Order rounds = subfolders of the catalog folder, newest first. */
export async function listRounds(): Promise<DriveFile[]> {
  const files = await listFolder(config().folderId);
  return files.filter((f) => f.mimeType === FOLDER_MIME).sort((a, b) => b.createdTime.localeCompare(a.createdTime));
}

/**
 * Resolves a round id sent by the client. Only direct subfolders of the catalog folder are accepted,
 * so these endpoints can't be used to read arbitrary Drive files.
 */
export async function findRound(roundId: string | null): Promise<DriveFile> {
  if (!roundId || !/^[\w-]{10,100}$/.test(roundId)) throw new HttpError(400, 'Missing or invalid round.');
  const round = (await listRounds()).find((r) => r.id === roundId);
  if (!round) throw new HttpError(404, 'Order round not found.');
  return round;
}

function isExcel(f: DriveFile): boolean {
  return f.mimeType === GOOGLE_SHEET_MIME || (/\.xlsx$/i.test(f.name) && !f.name.startsWith('~$'));
}

/** The catalog Excel file. If there are several, the most recently modified one wins. */
export function pickExcel(files: DriveFile[]): DriveFile {
  const excels = files.filter(isExcel).sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  if (!excels.length) throw new HttpError(404, 'No Excel file found in the round folder.');
  return excels[0];
}

export function pickImages(files: DriveFile[]): DriveFile[] {
  return files.filter((f) => f.mimeType.startsWith('image/'));
}

export async function downloadExcel(file: DriveFile): Promise<ArrayBuffer> {
  const { key } = config();
  const isSheet = file.mimeType === GOOGLE_SHEET_MIME;
  const url = new URL(DRIVE_API + '/' + encodeURIComponent(file.id) + (isSheet ? '/export' : ''));
  if (isSheet) url.searchParams.set('mimeType', XLSX_MIME);
  else url.searchParams.set('alt', 'media');
  url.searchParams.set('key', key);
  return (await driveFetch(url)).arrayBuffer();
}

export function excelDisplayName(file: DriveFile): string {
  return /\.xlsx$/i.test(file.name) ? file.name : file.name + '.xlsx';
}

export function errorResponse(err: unknown): Response {
  if (!(err instanceof HttpError)) {
    console.error(err);
    return Response.json({ error: 'Internal error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json(
    { ...err.data, error: err.message, code: err.code },
    { status: err.status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export { XLSX_MIME };
