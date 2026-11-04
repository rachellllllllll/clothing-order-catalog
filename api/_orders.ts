/**
 * Orders stored in Drive:
 *   ORDERS_FOLDER_ID/                      (private, created by the setup script)
 *     מזמינים/        the orderers list (see _members.ts)
 *     <round name>/   appProperties { round: <catalog round folder id>, locked, archived, closes: <YYYY-MM-DD>, shortages: <file id> }
 *       <orderer name>.json   appProperties = summary (see summaryProps) + mid (member id) for cheap admin listing
 *       shortages.json        appProperties { kind: 'shortages' } — units that did not arrive, per order file id
 */
import { signToken, verifyToken, bearerToken } from './_auth.js';
import { HttpError } from './_drive.js';
import {
  createFolder,
  createJsonFile,
  findFiles,
  FOLDER_MIME,
  ordersConfigured,
  ordersRootId,
  q,
  readJson,
  trashFile,
  updateJsonFile,
  updateProperties,
  type AppFile,
} from './_google.js';
import { memberLinkLogin, memberLogin, nameKey, sessionMember, sessionStamp, type StoredMember } from './_members.js';
import { findAppRound, findRound, listAllRounds, type RoundRef } from './_rounds.js';
import type {
  OrderDto,
  OrderLine,
  OrderResponse,
  OrderSummary,
  RoundDto,
  RoundState,
  ShortageLine,
  Shortages,
  SigninResponse,
  SubmittedDto,
} from './_types.js';

const MAX_LINES = 3000;
const TOKEN_MS = 180 * 24 * 60 * 60 * 1000;

interface StoredOrder {
  v: 1;
  name: string;
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
  /** Member id. */
  m: string;
  /** Code salt prefix — a new code changes the salt and so ends existing sessions. */
  p: string;
  exp: number;
}

/** Sign-in to the site (before choosing a round); exchanged for an OrderToken per round with `open`. */
interface MemberToken {
  k: 'member';
  /** Member id. */
  m: string;
  /** Code salt prefix (as in OrderToken). */
  p: string;
  exp: number;
}

// ── Validation ──

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
  };
}

// ── Round folders ──

function stateOf(folder: AppFile | null): RoundState {
  const p = folder?.appProperties;
  return { locked: p?.locked === '1', archived: p?.archived === '1', closesOn: p?.closes || null };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day `YYYY-MM-DD` that really exists (e.g. not 2026-02-30). */
function validDay(v: string): boolean {
  const d = new Date(v + 'T00:00:00Z');
  return DAY_RE.test(v) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

async function findRoundFolder(roundId: string): Promise<AppFile | null> {
  const files = await findFiles(
    `${q(ordersRootId())} in parents and mimeType = ${q(FOLDER_MIME)} and trashed = false and ` +
      `appProperties has { key='round' and value=${q(roundId)} }`,
  );
  return files[0] ?? null; // oldest wins if two requests ever created it at once
}

async function ensureRoundFolder(round: RoundRef): Promise<AppFile> {
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

/** The rounds with their state, newest first. Drafts (rounds still being prepared) are for the admin only. */
export async function listRoundDtos(includeDrafts: boolean): Promise<RoundDto[]> {
  const [rounds, states] = await Promise.all([listAllRounds(includeDrafts), roundStates()]);
  return rounds.map((r) => ({
    id: r.id,
    name: r.name,
    createdTime: r.createdTime,
    ...(states.get(r.id) ?? { locked: false, archived: false, closesOn: null }),
    ...(r.editable && { editable: true }),
    ...(r.draft && { draft: true }),
  }));
}

// ── Order files ──

async function orderFiles(folderId: string): Promise<AppFile[]> {
  return findFiles(`${q(folderId)} in parents and trashed = false and appProperties has { key='kind' and value='order' }`);
}

/** The member's order in the round folder. Orders from before the list are matched by name, then linked. */
async function findMemberOrder(folderId: string, memberId: string, name: string): Promise<AppFile | null> {
  const linked = await findFiles(
    `${q(folderId)} in parents and trashed = false and appProperties has { key='mid' and value=${q(memberId)} }`,
  );
  if (linked[0]) return linked[0];
  const byName = await findFiles(
    `${q(folderId)} in parents and trashed = false and appProperties has { key='kind' and value='order' } and ` +
      `appProperties has { key='nk' and value=${q(nameKey(name))} }`,
  );
  const legacy = byName.find((f) => !f.appProperties.mid);
  return legacy ? updateProperties(legacy.id, { mid: memberId }) : null;
}

async function readOrder(fileId: string): Promise<StoredOrder> {
  return parseStored(await readJson(fileId));
}

async function writeOrder(fileId: string, o: StoredOrder): Promise<void> {
  await updateJsonFile(fileId, summaryProps(o), o);
}

function issueToken(roundId: string, fileId: string, memberId: string, m: StoredMember): string {
  return signToken({ k: 'order', r: roundId, f: fileId, m: memberId, p: sessionStamp(m), exp: Date.now() + TOKEN_MS });
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

const sessionExpired = () => new HttpError(401, 'פג תוקף הכניסה — היכנסו שוב.', 'session_expired');

/** Signs in a member of the orderers list (before choosing a round). */
export async function signin(name: string, pin: string): Promise<SigninResponse> {
  return memberSignin(await memberLogin(name, pin));
}

/** Signs in with the personal link the admin mailed to the member. */
export async function linkSignin(key: unknown): Promise<SigninResponse> {
  return memberSignin(await memberLinkLogin(key));
}

function memberSignin({ id, member }: { id: string; member: StoredMember }): SigninResponse {
  const token = signToken({ k: 'member', m: id, p: sessionStamp(member), exp: Date.now() + TOKEN_MS });
  return { name: member.name, token };
}

/** The member signed in with `signin` (`Authorization: Bearer`). */
async function signedInMember(request: Request): Promise<{ id: string; member: StoredMember }> {
  const token = verifyToken<MemberToken>(bearerToken(request));
  if (!token || token.k !== 'member' || typeof token.m !== 'string') throw sessionExpired();
  const member = await sessionMember(token.m, token.p);
  if (!member) throw sessionExpired();
  return { id: token.m, member };
}

/** Opens the signed-in member's order in the round (`Authorization: Bearer` from `signin`). */
export async function openOrder(request: Request, roundId: unknown): Promise<OrderResponse> {
  const { id, member } = await signedInMember(request);
  const round = await findRound(roundId);
  return openMemberOrder(round, id, member);
}

/**
 * The closed (locked/archived) rounds in which the signed-in member ordered something (or sent an order).
 * Lets the round list hide old rounds that are of no use to them.
 */
export async function orderedClosedRounds(request: Request): Promise<string[]> {
  const { id: memberId, member } = await signedInMember(request);
  if (!ordersConfigured()) return [];
  const folders = await findFiles(`${q(ordersRootId())} in parents and mimeType = ${q(FOLDER_MIME)} and trashed = false`);
  const closed = folders.filter((f) => {
    const s = stateOf(f);
    return f.appProperties.round && (s.locked || s.archived);
  });
  const nk = nameKey(member.name);
  const found = await Promise.all(
    closed.map(async (folder) => {
      // Orders from before the list are not linked yet: matched by name, as when opened.
      const mine = (await orderFiles(folder.id)).filter((f) => {
        const p = f.appProperties;
        return p.mid ? p.mid === memberId : p.nk === nk;
      });
      return mine.some((f) => Number(f.appProperties.units) > 0 || !!f.appProperties.sub) ? folder.appProperties.round : null;
    }),
  );
  return [...new Set(found.filter((id): id is string => !!id))];
}

/** Signs in and opens the order in the round in one step. */
export async function login(roundId: unknown, name: string, pin: string): Promise<OrderResponse> {
  const round = await findRound(roundId);
  const { id: memberId, member } = await memberLogin(name, pin);
  return openMemberOrder(round, memberId, member);
}

/** The member's order in the round; opened on their first visit (while the round is open). */
async function openMemberOrder(round: RoundRef, memberId: string, member: StoredMember): Promise<OrderResponse> {
  let folder = await findRoundFolder(round.id);
  const state = stateOf(folder);
  const file = folder ? await findMemberOrder(folder.id, memberId, member.name) : null;

  if (!file) {
    if (state.locked || state.archived) {
      throw new HttpError(404, 'אין לך הזמנה בסבב הזה. הסבב כבר סגור להזמנות חדשות.', 'no_order');
    }
    folder ??= await ensureRoundFolder(round);
    const now = new Date().toISOString();
    const o: StoredOrder = { v: 1, name: member.name, rev: 1, createdAt: now, updatedAt: now, lines: [], submitted: null };
    const created = await createJsonFile(folder.id, member.name + '.json', { ...summaryProps(o), mid: memberId }, o);
    return { order: toDto(o), round: state, token: issueToken(round.id, created.id, memberId, member), created: true };
  }

  const o = await readOrder(file.id);
  return {
    order: toDto(o),
    round: state,
    token: issueToken(round.id, file.id, memberId, member),
    shortages: await orderShortages(folder!, file.id, state),
  };
}

export interface OrderSession {
  fileId: string;
  order: StoredOrder;
  state: RoundState;
  folder: AppFile;
}

/** Resolves the `Authorization: Bearer` session of an orderer. */
export async function authorize(request: Request): Promise<OrderSession> {
  const token = verifyToken<OrderToken>(bearerToken(request));
  if (!token || token.k !== 'order' || typeof token.m !== 'string') throw sessionExpired();
  const [folder, member] = await Promise.all([findRoundFolder(token.r), sessionMember(token.m, token.p)]);
  if (!folder || !member) throw sessionExpired();
  let order: StoredOrder;
  try {
    order = await readOrder(token.f);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw sessionExpired();
    throw err;
  }
  return { fileId: token.f, order, state: stateOf(folder), folder };
}

export async function loadResponse(session: OrderSession): Promise<OrderResponse> {
  return {
    order: toDto(session.order),
    round: session.state,
    shortages: await orderShortages(session.folder, session.fileId, session.state),
  };
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

// ── Shortages (units that did not arrive from the supplier) ──

const SHORTAGES_FILE = 'shortages.json';

function parseShortageLines(raw: unknown): ShortageLine[] {
  return parseLines(raw, false).map(({ id, size, qty }) => ({ id, size, qty }));
}

async function readShortages(folder: AppFile): Promise<Shortages> {
  const fileId = folder.appProperties.shortages;
  if (!fileId) return {};
  let raw: unknown;
  try {
    raw = await readJson(fileId);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return {};
    throw err;
  }
  const orders = (raw as { orders?: unknown } | null)?.orders;
  const out: Shortages = {};
  if (orders && typeof orders === 'object') {
    for (const [id, lines] of Object.entries(orders)) {
      const parsed = parseShortageLines(lines);
      if (parsed.length) out[id] = parsed;
    }
  }
  return out;
}

/** What the orderer sees: only once the round is closed, since the marks follow the delivery. */
async function orderShortages(folder: AppFile, fileId: string, state: RoundState): Promise<ShortageLine[] | undefined> {
  if (!state.locked && !state.archived) return undefined;
  return (await readShortages(folder))[fileId] ?? [];
}

async function writeShortages(folder: AppFile, orders: Shortages): Promise<void> {
  const data = { v: 1, updatedAt: new Date().toISOString(), orders };
  const fileId = folder.appProperties.shortages;
  if (fileId) {
    try {
      await updateJsonFile(fileId, { kind: 'shortages' }, data);
      return;
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  }
  const created = await createJsonFile(folder.id, SHORTAGES_FILE, { kind: 'shortages' }, data);
  await updateProperties(folder.id, { shortages: created.id });
}

// ── Admin actions ──

async function requireRoundFolder(roundId: unknown): Promise<AppFile | null> {
  const round = await findRound(roundId, true);
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

/** Every order of the round with its lines, and the units that did not arrive. */
export async function allOrders(
  roundId: unknown,
): Promise<{ orders: { fileId: string; order: OrderDto }[]; shortages: Shortages }> {
  const folder = await requireRoundFolder(roundId);
  const files = folder ? await orderFiles(folder.id) : [];
  const shortages = folder ? readShortages(folder) : Promise.resolve({});
  shortages.catch(() => undefined); // awaited below; avoids an unhandled rejection while the orders load
  const out: { fileId: string; order: OrderDto }[] = [];
  // A few downloads at a time keeps well within Drive's rate limits.
  for (let i = 0; i < files.length; i += 6) {
    const batch = files.slice(i, i + 6);
    const orders = await Promise.all(batch.map((f) => readOrder(f.id)));
    batch.forEach((f, j) => out.push({ fileId: f.id, order: toDto(orders[j]) }));
  }
  return { orders: out, shortages: await shortages };
}

/**
 * Marks how many units of orderers' lines did not arrive (qty 0 clears a mark). Applied as a patch on the
 * stored marks, so two admins marking different lines don't overwrite each other. Closed rounds only.
 */
export async function setShortages(roundId: unknown, rawChanges: unknown): Promise<{ shortages: Shortages }> {
  const folder = await requireRoundFolder(roundId);
  if (!folder) throw new HttpError(404, 'אין הזמנות בסבב הזה.', 'not_found');
  const state = stateOf(folder);
  if (!state.locked && !state.archived) {
    throw new HttpError(409, 'אפשר לסמן פריטים שלא הגיעו רק אחרי נעילת הסבב.', 'not_locked');
  }
  if (!Array.isArray(rawChanges) || !rawChanges.length || rawChanges.length > MAX_LINES) {
    throw new HttpError(400, 'Invalid shortage changes.');
  }
  const fileIds = new Set((await orderFiles(folder.id)).map((f) => f.id));
  const changes = (rawChanges as Record<string, unknown>[]).map((c) => {
    const fileId = str(c?.fileId, 200);
    const id = str(c?.id, 300);
    const size = str(c?.size, 60);
    const qty = c?.qty;
    const valid = fileId && fileIds.has(fileId) && id && size && typeof qty === 'number' && Number.isInteger(qty) && qty >= 0 && qty <= 9999;
    if (!valid) throw new HttpError(400, 'Invalid shortage change.');
    return { fileId, id, size, qty };
  });

  const orders = await readShortages(folder);
  for (const c of changes) {
    const lines = (orders[c.fileId] ?? []).filter((l) => l.id !== c.id || l.size !== c.size);
    if (c.qty > 0) lines.push({ id: c.id, size: c.size, qty: c.qty });
    if (lines.length) orders[c.fileId] = lines;
    else delete orders[c.fileId];
  }
  await writeShortages(folder, orders);
  return { shortages: orders };
}

export async function setRoundState(
  roundId: unknown,
  patch: { locked?: unknown; archived?: unknown; closesOn?: unknown },
): Promise<{ round: RoundState }> {
  const props: Record<string, string | null> = {};
  if (typeof patch.locked === 'boolean') props.locked = patch.locked ? '1' : '0';
  if (typeof patch.archived === 'boolean') props.archived = patch.archived ? '1' : '0';
  if (patch.closesOn === null || patch.closesOn === '') props.closes = null;
  else if (typeof patch.closesOn === 'string' && validDay(patch.closesOn)) props.closes = patch.closesOn;
  else if (patch.closesOn !== undefined) throw new HttpError(400, 'Invalid closing date.');
  const round = await findRound(roundId, true);
  const folder = await ensureRoundFolder(round);
  const updated = await updateProperties(folder.id, props);
  return { round: stateOf(updated) };
}

/**
 * Deletes (to the Drive trash) a round created on the admin page, with its orders folder.
 * Refused once anyone ordered or sent an order in it — such a round can be archived instead.
 */
export async function deleteRound(roundId: unknown): Promise<{ ok: true }> {
  const round = await findAppRound(roundId);
  const folder = await findRoundFolder(round.id);
  if (folder) {
    const orders = await orderFiles(folder.id);
    if (orders.some((f) => Number(f.appProperties.units) > 0 || f.appProperties.sub)) {
      throw new HttpError(409, 'יש בסבב הזמנות — אי אפשר למחוק אותו (אפשר להעביר לארכיון).', 'has_orders');
    }
    await trashFile(folder.id);
  }
  await trashFile(round.folder.id);
  return { ok: true };
}
