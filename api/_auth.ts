/**
 * Request parsing, signed tokens, PIN hashing and the admin session cookie.
 *
 * Environment variables:
 *   SESSION_SECRET  – long random string; signs orderer tokens and the admin cookie
 *                     (changing it signs everyone out, nothing else)
 *   ADMIN_PASSWORD  – shared password of the admin page (at least 8 characters)
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { HttpError } from './_drive.js';
import { getFile, ordersRootId, updateProperties } from './_google.js';

const MAX_BODY_BYTES = 1_000_000;

/** Parses a JSON POST body. Requiring the JSON content type blocks cross-site form posts (CSRF). */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get('content-type') || '').includes('application/json')) {
    throw new HttpError(415, 'Expected a JSON body.');
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large.');
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Invalid JSON body.');
}

export function noStoreJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  return Response.json(body, { ...init, headers });
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new HttpError(500, 'SESSION_SECRET is not configured (at least 16 characters).');
  return s;
}

function hmac(data: string): Buffer {
  return createHmac('sha256', secret()).update(data).digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `base64url(json).base64url(hmac)` — tamper-proof, not encrypted (holds no secrets). */
export function signToken(payload: { exp: number } & Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + hmac(body).toString('base64url');
}

export function verifyToken<T extends { exp: number }>(token: string | null | undefined): T | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(Buffer.from(sig, 'base64url'), hmac(body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
    return typeof payload.exp === 'number' && payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export function bearerToken(request: Request): string | null {
  const m = /^Bearer (\S+)$/.exec(request.headers.get('authorization') || '');
  return m ? m[1] : null;
}

// ── PIN ──

export interface StoredPin {
  salt: string;
  hash: string;
}

export function parsePin(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{4}$/.test(raw)) throw new HttpError(400, 'הקוד צריך להיות 4 ספרות.', 'bad_pin');
  return raw;
}

export function hashPin(pin: string): StoredPin {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(pin, salt, 32).toString('hex') };
}

export function checkPin(pin: string, stored: StoredPin): boolean {
  return safeEqual(scryptSync(pin, stored.salt, 32), Buffer.from(stored.hash, 'hex'));
}

// ── Admin session ──

const ADMIN_COOKIE = 'orderUiAdmin';
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const ADMIN_MAX_FAILS = 10;
const ADMIN_LOCK_MS = 15 * 60 * 1000;

function adminPassword(): string {
  const p = process.env.ADMIN_PASSWORD;
  if (!p || p.length < 8) throw new HttpError(500, 'ADMIN_PASSWORD is not configured (at least 8 characters).');
  return p;
}

/** Changes when the password changes, so a new password signs every admin out. */
function passwordFingerprint(): string {
  return hmac('admin:' + adminPassword()).toString('base64url').slice(0, 16);
}

function cookie(value: string, maxAgeSec: number): string {
  return `${ADMIN_COOKIE}=${value}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

export const clearAdminCookie = cookie('', 0);

/**
 * Checks the shared admin password. Failed attempts are counted on the orders folder itself
 * (serverless functions keep no memory), and lock the login for a while after too many.
 */
export async function adminLogin(password: unknown): Promise<string> {
  const expected = adminPassword();
  const root = await getFile(ordersRootId());
  const lockUntil = Date.parse(root.appProperties.adminLockUntil || '');
  if (lockUntil > Date.now()) {
    const minutes = Math.ceil((lockUntil - Date.now()) / 60000);
    throw new HttpError(429, `יותר מדי ניסיונות שגויים. נסו שוב בעוד ${minutes} דקות.`, 'too_many');
  }
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const ok = typeof password === 'string' && safeEqual(digest(password), digest(expected));
  if (!ok) {
    const fails = Number(root.appProperties.adminFails || 0) + 1;
    await updateProperties(
      root.id,
      fails >= ADMIN_MAX_FAILS
        ? { adminFails: '0', adminLockUntil: new Date(Date.now() + ADMIN_LOCK_MS).toISOString() }
        : { adminFails: String(fails) },
    );
    throw new HttpError(401, 'סיסמה שגויה.', 'wrong_password');
  }
  if (root.appProperties.adminFails && root.appProperties.adminFails !== '0') {
    await updateProperties(root.id, { adminFails: '0', adminLockUntil: null });
  }
  const token = signToken({ k: 'admin', v: passwordFingerprint(), exp: Date.now() + ADMIN_SESSION_MS });
  return cookie(token, ADMIN_SESSION_MS / 1000);
}

export function isAdmin(request: Request): boolean {
  const raw = (request.headers.get('cookie') || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(ADMIN_COOKIE + '='));
  const token = verifyToken<{ k: string; v: string; exp: number }>(raw?.slice(ADMIN_COOKIE.length + 1));
  return !!token && token.k === 'admin' && token.v === passwordFingerprint();
}

export function requireAdmin(request: Request): void {
  if (!isAdmin(request)) throw new HttpError(401, 'נדרשת כניסת מנהל.', 'admin_required');
}
