/**
 * Google Drive access with the owner's OAuth refresh token — used to store the orders.
 * Scope `drive.file`: the app can only see files and folders it created itself
 * (the orders folder created by scripts/get-refresh-token.mjs and everything inside it).
 *
 * Environment variables:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET – OAuth client (type "Desktop app")
 *   GOOGLE_REFRESH_TOKEN                   – printed by scripts/get-refresh-token.mjs
 *   ORDERS_FOLDER_ID                       – the private orders folder (also printed by the script)
 */
import { randomBytes } from 'node:crypto';
import { HttpError } from './_drive.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILES_API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FILE_FIELDS = 'id, name, createdTime, modifiedTime, appProperties';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface AppFile {
  id: string;
  name: string;
  createdTime: string;
  modifiedTime: string;
  /** Private key/value metadata visible only to this app (max 124 bytes per key + value). */
  appProperties: Record<string, string>;
}

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  ordersFolderId: string;
}

export function ordersConfigured(): boolean {
  const e = process.env;
  return !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && e.GOOGLE_REFRESH_TOKEN && e.ORDERS_FOLDER_ID);
}

function config(): OAuthConfig {
  const e = process.env;
  if (!ordersConfigured()) throw new HttpError(503, 'שמירת הזמנות עדיין לא הוגדרה בשרת.', 'not_configured');
  if (!/^[\w-]+$/.test(e.ORDERS_FOLDER_ID!)) throw new HttpError(500, 'Invalid ORDERS_FOLDER_ID.');
  return {
    clientId: e.GOOGLE_CLIENT_ID!,
    clientSecret: e.GOOGLE_CLIENT_SECRET!,
    refreshToken: e.GOOGLE_REFRESH_TOKEN!,
    ordersFolderId: e.ORDERS_FOLDER_ID!,
  };
}

export function ordersRootId(): string {
  return config().ordersFolderId;
}

/** Quotes a value for a Drive query string. */
export function q(value: string): string {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// Reused while the function instance stays warm.
let cachedToken: { token: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  const c = config();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    console.error('OAuth token refresh failed', res.status, await res.text());
    throw new HttpError(502, 'Google authorization failed — the refresh token may be revoked or expired.');
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return cachedToken.token;
}

async function gfetch(url: URL | string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer ' + (await accessToken()));
  const res = await fetch(url, { ...init, headers });
  if (res.status === 404) throw new HttpError(404, 'Not found.', 'not_found');
  if (!res.ok) {
    console.error('Drive API error', res.status, await res.text());
    throw new HttpError(502, 'Google Drive request failed (' + res.status + ').');
  }
  return res;
}

function normalize(raw: unknown): AppFile {
  const f = raw as Partial<AppFile>;
  return {
    id: f.id ?? '',
    name: f.name ?? '',
    createdTime: f.createdTime ?? '',
    modifiedTime: f.modifiedTime ?? '',
    appProperties: f.appProperties ?? {},
  };
}

/** Files matching a Drive query, oldest first. */
export async function findFiles(query: string): Promise<AppFile[]> {
  const files: AppFile[] = [];
  let pageToken = '';
  do {
    const url = new URL(FILES_API);
    url.searchParams.set('q', query);
    url.searchParams.set('fields', `nextPageToken, files(${FILE_FIELDS})`);
    url.searchParams.set('orderBy', 'createdTime');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = (await (await gfetch(url)).json()) as { files: Partial<AppFile>[]; nextPageToken?: string };
    files.push(...body.files.map(normalize));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return files;
}

export async function getFile(fileId: string): Promise<AppFile> {
  const url = new URL(FILES_API + '/' + encodeURIComponent(fileId));
  url.searchParams.set('fields', FILE_FIELDS);
  return normalize(await (await gfetch(url)).json());
}

export async function createFolder(name: string, parentId: string, appProperties: Record<string, string>): Promise<AppFile> {
  const url = new URL(FILES_API);
  url.searchParams.set('fields', FILE_FIELDS);
  const res = await gfetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId], appProperties }),
  });
  return normalize(await res.json());
}

/** Merges into the file's appProperties (a null value deletes the key). */
export async function updateProperties(fileId: string, appProperties: Record<string, string | null>): Promise<AppFile> {
  const url = new URL(FILES_API + '/' + encodeURIComponent(fileId));
  url.searchParams.set('fields', FILE_FIELDS);
  const res = await gfetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appProperties }),
  });
  return normalize(await res.json());
}

export async function readJson(fileId: string): Promise<unknown> {
  const url = new URL(FILES_API + '/' + encodeURIComponent(fileId));
  url.searchParams.set('alt', 'media');
  return (await gfetch(url)).json();
}

function multipart(metadata: object, data: unknown): { body: string; contentType: string } {
  const boundary = 'orderui-' + randomBytes(12).toString('hex');
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(data)}\r\n` +
    `--${boundary}--`;
  return { body, contentType: 'multipart/related; boundary=' + boundary };
}

export async function createJsonFile(
  parentId: string,
  name: string,
  appProperties: Record<string, string>,
  data: unknown,
): Promise<AppFile> {
  const url = new URL(UPLOAD_API);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('fields', FILE_FIELDS);
  const { body, contentType } = multipart({ name, parents: [parentId], mimeType: 'application/json', appProperties }, data);
  const res = await gfetch(url, { method: 'POST', headers: { 'Content-Type': contentType }, body });
  return normalize(await res.json());
}

export async function updateJsonFile(fileId: string, appProperties: Record<string, string>, data: unknown): Promise<AppFile> {
  const url = new URL(UPLOAD_API + '/' + encodeURIComponent(fileId));
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('fields', FILE_FIELDS);
  const { body, contentType } = multipart({ appProperties }, data);
  const res = await gfetch(url, { method: 'PATCH', headers: { 'Content-Type': contentType }, body });
  return normalize(await res.json());
}
