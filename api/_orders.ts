/**
 * Orders stored in Drive:
 *   ORDERS_FOLDER_ID/                      (private, created by the setup script)
 *     <round name>/   appProperties { round: <catalog round folder id>, locked, archived }
 *       <orderer name>.json   appProperties = summary (see summaryProps) for cheap admin listing
 */
import { createHash } from 'node:crypto';
import { checkPin, hashPin, signToken, verifyToken, bearerToken, type StoredPin } from './_auth.js';
import { findRound, HttpError, type DriveFile } from './_drive.js';
import {
  createFolder,
  createJsonFile,
  findFiles,
  FOLDER_MIME,
  ordersConfigured,
  ordersRootId,
  q,
  readJson,
  updateJsonFile,
  updateProperties,
  type AppFile,
} from './_google.js';
import type { OrderDto, OrderLine, OrderResponse, OrderSummary, RoundState, SubmittedDto } from './_types.js';

const MAX_LINES = 3000;
const MAX_PIN_FAILS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const TOKEN_MS = 180 * 24 * 60 * 60 * 1000;

interface StoredOrder {
  v: 1;
  name: string;
  pin: StoredPin | null;
  fails: number;
  lockUntil: string | null;
  rev: number;
  createdAt: string;
  updatedAt: string;
  lines: OrderLine[];
  submitted: SubmittedDto | null;
}

interface OrderToken {
  k: 'order';
  /** Round (catalog folder) id. */
  r: string;
  /** Order file id. */
  f: string;
  /** PIN salt prefix — a PIN reset changes the salt and so ends existing sessions. */
  p: string;
  exp: number;
}

// ── Validation ──

export function parseName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.normalize('NFC').replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim() : '';
  if (name.length < 2 || name.length > 40) throw new HttpError(400, 'השם צריך להכיל 2–40 תווים.', 'bad_name');
  return name;
}

/** Case/space-insensitive name identity, hashed so it is safe to put in Drive queries. */
export function nameKey(name: string): string {
  return createHash('sha256').update('name:' + name.toLowerCase()).digest('hex').slice(0, 32);
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max ? v : null;
}

/** Validates order lines from the client (`strict`) or from a stored file (invalid lines are dropped). */
export function parseLines(raw: unknown, strict = true): OrderLine[] {
  if (!Array.isArray(raw) || raw.length > MAX_LINES) {
    if (strict) throw new HttpError(400, 'Invalid order lines.');
    return [];
  }
  const lines: OrderLine[] = [];
  for (const l of raw as Record<string, unknown>[]) {
    const id = str(l?.id, 300);
    const size = str(l?.size, 60);
    const qty = l?.qty;
    const valid = id && size && typeof qty === 'number' && Number.isInteger(qty) && qty > 0 && qty <= 9999;
    if (!valid) {
      if (strict) throw new HttpError(400, 'Invalid order line.');
      continue;
    }
    lines.push({ id, size, qty, model: str(l.model, 200) ?? '', color: str(l.color, 200) ?? '' });
  }
  return lines;
}

function parseStored(raw: unknown): StoredOrder {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoredOrder>;
  const sub = o.submitted;
  return {
    v: 1,
    name: typeof o.name === 'string' ? o.name : '',
    pin: o.pin && typeof o.pin.salt === 'string' && typeof o.pin.hash === 'string' ? o.pin : null,
    fails: Number(o.fails) || 0,
    lockUntil: typeof o.lockUntil === 'string' ? o.lockUntil : null,
    rev: Number(o.rev) || 0,
    createdAt: String(o.createdAt ?? ''),
    updatedAt: String(o.updatedAt ?? ''),
    lines: parseLines(o.lines, false),
    submitted:
      sub && typeof sub.at === 'string'
        ? { at: sub.at, rev: Number(sub.rev) || 0, lines: parseLines(sub.lines, false) }
        : null,
  };
}

function toDto(o: StoredOrder): OrderDto {
  return {
    name: o.name,
    rev: o.rev,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    lines: o.lines,
    submitted: o.submitted,
  };
}

const units = (lines: OrderLine[]) => lines.reduce((s, l) => s + l.qty, 0);

function summaryProps(o: StoredOrder): Record<string, string> {
  return {
    kind: 'order',
    nk: nameKey(o.name),
    rev: String(o.rev),
    units: String(units(o.lines)),
    upd: o.updatedAt,
    sub: o.submitted?.at ?? '',
    srev: o.submitted ? String(o.submitted.rev) : '',
    pin: o.pin ? '1' : '0',
  };
}

function summaryOf(f: AppFile): OrderSummary {
  const p = f.appProperties;
  return {
    fileId: f.id,
    name: f.name.replace(/\.json$/i, ''),
    rev: Number(p.rev) || 0,
    units: Number(p.units) || 0,
    updatedAt: p.upd || f.modifiedTime,
    submittedAt: p.sub || null,
    submittedRev: p.srev ? Number(p.srev) : null,
    hasPin: p.pin === '1',
  };
}

// ── Round folders ──

function stateOf(folder: AppFile | null): RoundState {
  return { locked: folder?.appProperties.locked === '1', archived: folder?.appProperties.archived === '1' };
}

async function findRoundFolder(roundId: string): Promise<AppFile | null> {
  const files = await findFiles(
    `${q(ordersRootId())} in parents and mimeType = ${q(FOLDER_MIME)} and trashed = false and ` +
      `appProperties has { key='round' and value=${q(roundId)} }`,
  );
  return files[0] ?? null; // oldest wins if two requests ever created it at once
}

async function ensureRoundFolder(round: DriveFile): Promise<AppFile> {
  return (await findRoundFolder(round.id)) ?? createFolder(round.name, ordersRootId(), { round: round.id });
}

/** Lock/archive state of every round that has an orders folder. Empty when orders aren't configured yet. */
export async function roundStates(): Promise<Map<string, RoundState>> {
  const map = new Map<string, RoundState>();
  if (!ordersConfigured()) return map;
  const folders = await findFiles(`${q(ordersRootId())} in parents and mimeType = ${q(FOLDER_MIME)} and trashed = false`);
  for (const f of folders) {
    const id = f.appProperties.round;
    if (id && !map.has(id)) map.set(id, stateOf(f));
  }
  return map;
}

// ── Order files ──

async function orderFiles(folderId: string): Promise<AppFile[]> {
  return findFiles(`${q(folderId)} in parents and trashed = false and appProperties has { key='kind' and value='order' }`);
}

async function findOrderFile(folderId: string, name: string): Promise<AppFile | null> {
  const files = await findFiles(
    `${q(folderId)} in parents and trashed = false and appProperties has { key='nk' and value=${q(nameKey(name))} }`,
  );
  return files[0] ?? null;
}

async function readOrder(fileId: string): Promise<StoredOrder> {
  return parseStored(await readJson(fileId));
}

async function writeOrder(fileId: string, o: StoredOrder): Promise<void> {
  await updateJsonFile(fileId, summaryProps(o), o);
}

function issueToken(roundId: string, fileId: string, o: StoredOrder): string {
  return signToken({ k: 'order', r: roundId, f: fileId, p: o.pin!.salt.slice(0, 8), exp: Date.now() + TOKEN_MS });
}

function lockedError(state: RoundState): HttpError {
  return new HttpError(
    423,
    state.archived ? 'הסבב הועבר לארכיון — צפייה בלבד.' : 'הסבב נעול — אי אפשר לשנות הזמנות.',
    'locked',
    { round: state },
  );
}

// ── Orderer actions ──

export async function login(roundId: unknown, name: string, pin: string, create: boolean): Promise<OrderResponse> {
  const round = await findRound(typeof roundId === 'string' ? roundId : null);
  let folder = await findRoundFolder(round.id);
  const state = stateOf(folder);
  const file = folder ? await findOrderFile(folder.id, name) : null;
  const now = new Date();

  if (!file) {
    if (!create) throw new HttpError(404, 'לא נמצאה הזמנה בשם הזה בסבב.', 'not_found');
    if (state.locked || state.archived) throw lockedError(state);
    folder ??= await ensureRoundFolder(round);
    const o: StoredOrder = {
      v: 1,
      name,
      pin: hashPin(pin),
      fails: 0,
      lockUntil: null,
      rev: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lines: [],
      submitted: null,
    };
    const created = await createJsonFile(folder.id, name + '.json', summaryProps(o), o);
    return { order: toDto(o), round: state, token: issueToken(round.id, created.id, o), pinSet: true };
  }

  const o = await readOrder(file.id);
  const lockUntil = Date.parse(o.lockUntil || '');
  if (lockUntil > now.getTime()) {
    const minutes = Math.ceil((lockUntil - now.getTime()) / 60000);
    throw new HttpError(429, `יותר מדי ניסיונות שגויים. נסו שוב בעוד ${minutes} דקות.`, 'too_many');
  }

  // After an admin PIN reset, the next login sets the new PIN.
  if (!o.pin) {
    o.pin = hashPin(pin);
    o.fails = 0;
    o.lockUntil = null;
    await writeOrder(file.id, o);
    return { order: toDto(o), round: state, token: issueToken(round.id, file.id, o), pinSet: true };
  }

  if (!checkPin(pin, o.pin)) {
    o.fails += 1;
    const blocked = o.fails >= MAX_PIN_FAILS;
    if (blocked) {
      o.fails = 0;
      o.lockUntil = new Date(now.getTime() + PIN_LOCK_MS).toISOString();
    }
    await writeOrder(file.id, o);
    if (blocked) throw new HttpError(429, 'יותר מדי ניסיונות שגויים. נסו שוב בעוד 15 דקות.', 'too_many');
    throw new HttpError(401, 'קוד שגוי.', 'wrong_pin', { attemptsLeft: MAX_PIN_FAILS - o.fails });
  }

  if (o.fails || o.lockUntil) {
    o.fails = 0;
    o.lockUntil = null;
    await writeOrder(file.id, o);
  }
  return { order: toDto(o), round: state, token: issueToken(round.id, file.id, o) };
}

export interface OrderSession {
  fileId: string;
  order: StoredOrder;
  state: RoundState;
}

/** Resolves the `Authorization: Bearer` session of an orderer. */
export async function authorize(request: Request): Promise<OrderSession> {
  const expired = () => new HttpError(401, 'פג תוקף הכניסה — היכנסו שוב.', 'session_expired');
  const token = verifyToken<OrderToken>(bearerToken(request));
  if (!token || token.k !== 'order') throw expired();
  const folder = await findRoundFolder(token.r);
  if (!folder) throw expired();
  let order: StoredOrder;
  try {
    order = await readOrder(token.f);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw expired();
    throw err;
  }
  if (!order.pin || order.pin.salt.slice(0, 8) !== token.p) throw expired();
  return { fileId: token.f, order, state: stateOf(folder) };
}

export function loadResponse(session: OrderSession): OrderResponse {
  return { order: toDto(session.order), round: session.state };
}

/** Saves the lines (and with `submit`, marks this version as sent). `baseRev` must match the stored revision. */
export async function saveOrder(
  session: OrderSession,
  lines: OrderLine[],
  baseRev: unknown,
  submit: boolean,
): Promise<OrderResponse> {
  const { order: o, state } = session;
  if (state.locked || state.archived) throw lockedError(state);
  if (baseRev !== o.rev) {
    throw new HttpError(409, 'ההזמנה עודכנה ממכשיר אחר.', 'conflict', { order: toDto(o) });
  }
  const changed = JSON.stringify(lines) !== JSON.stringify(o.lines);
  const now = new Date().toISOString();
  if (changed) {
    o.lines = lines;
    o.rev += 1;
    o.updatedAt = now;
  }
  if (submit) o.submitted = { at: now, rev: o.rev, lines };
  if (changed || submit) await writeOrder(session.fileId, o);
  return { order: toDto(o), round: state };
}

// ── Admin actions ──

async function requireRoundFolder(roundId: unknown): Promise<AppFile | null> {
  const round = await findRound(typeof roundId === 'string' ? roundId : null);
  return findRoundFolder(round.id);
}

export async function listOrders(roundId: unknown): Promise<{ round: RoundState; orders: OrderSummary[] }> {
  const folder = await requireRoundFolder(roundId);
  const orders = folder ? (await orderFiles(folder.id)).map(summaryOf) : [];
  orders.sort((a, b) => a.name.localeCompare(b.name, 'he'));
  return { round: stateOf(folder), orders };
}

async function orderFileInRound(roundId: unknown, fileId: unknown): Promise<AppFile> {
  const folder = await requireRoundFolder(roundId);
  const file = folder ? (await orderFiles(folder.id)).find((f) => f.id === fileId) : undefined;
  if (!file) throw new HttpError(404, 'ההזמנה לא נמצאה.', 'not_found');
  return file;
}

export async function adminOrder(roundId: unknown, fileId: unknown): Promise<{ order: OrderDto }> {
  const file = await orderFileInRound(roundId, fileId);
  return { order: toDto(await readOrder(file.id)) };
}

/** Every order of the round with its lines (for the combined Excel). */
export async function allOrders(roundId: unknown): Promise<{ orders: { fileId: string; order: OrderDto }[] }> {
  const folder = await requireRoundFolder(roundId);
  const files = folder ? await orderFiles(folder.id) : [];
  const out: { fileId: string; order: OrderDto }[] = [];
  // A few downloads at a time keeps well within Drive's rate limits.
  for (let i = 0; i < files.length; i += 6) {
    const batch = files.slice(i, i + 6);
    const orders = await Promise.all(batch.map((f) => readOrder(f.id)));
    batch.forEach((f, j) => out.push({ fileId: f.id, order: toDto(orders[j]) }));
  }
  return { orders: out };
}

export async function setRoundState(roundId: unknown, patch: { locked?: unknown; archived?: unknown }): Promise<{ round: RoundState }> {
  const round = await findRound(typeof roundId === 'string' ? roundId : null);
  const folder = await ensureRoundFolder(round);
  const props: Record<string, string> = {};
  if (typeof patch.locked === 'boolean') props.locked = patch.locked ? '1' : '0';
  if (typeof patch.archived === 'boolean') props.archived = patch.archived ? '1' : '0';
  const updated = await updateProperties(folder.id, props);
  return { round: stateOf(updated) };
}

/** Clears the PIN: the next login with this name sets a new one (and ends existing sessions). */
export async function resetPin(roundId: unknown, fileId: unknown): Promise<{ ok: true }> {
  const file = await orderFileInRound(roundId, fileId);
  const o = await readOrder(file.id);
  o.pin = null;
  o.fails = 0;
  o.lockUntil = null;
  await writeOrder(file.id, o);
  return { ok: true };
}
