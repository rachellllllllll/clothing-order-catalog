/**
 * The orderers list: only people the admin added can sign in, with the name and the 6-digit code
 * the admin issued. Stored in Drive:
 *   ORDERS_FOLDER_ID/
 *     מזמינים/          appProperties { kind: 'members' }
 *       <name>.json     appProperties { kind: 'member', nk, active, phone, last } — summary for cheap listing
 * The member id is the file id; order files point to it with appProperties.mid.
 */
import { createHash } from 'node:crypto';
import { checkPin, generatePin, hashPin, type StoredPin } from './_auth.js';
import { HttpError } from './_drive.js';
import {
  createFolder,
  createJsonFile,
  findFiles,
  FOLDER_MIME,
  getFile,
  ordersRootId,
  q,
  readJson,
  trashFile,
  updateJsonFile,
  type AppFile,
} from './_google.js';
import type { IssuedCode, MemberDto } from './_types.js';

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const MAX_ADD = 100;

export interface StoredMember {
  v: 1;
  name: string;
  phone: string;
  pin: StoredPin | null;
  active: boolean;
  fails: number;
  lockUntil: string | null;
  createdAt: string;
  lastLoginAt: string | null;
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

function parsePhone(raw: unknown): string {
  if (raw == null) return '';
  const phone = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : null;
  if (phone === null || !/^[\d +()-]{0,20}$/.test(phone)) throw new HttpError(400, 'מספר הטלפון לא תקין.', 'bad_phone');
  return phone;
}

function parseId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[\w-]{1,200}$/.test(raw)) throw new HttpError(400, 'Invalid member id.');
  return raw;
}

// ── Storage ──

function parseStored(raw: unknown): StoredMember {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoredMember>;
  return {
    v: 1,
    name: typeof m.name === 'string' ? m.name : '',
    phone: typeof m.phone === 'string' ? m.phone : '',
    pin: m.pin && typeof m.pin.salt === 'string' && typeof m.pin.hash === 'string' ? m.pin : null,
    active: m.active !== false,
    fails: Number(m.fails) || 0,
    lockUntil: typeof m.lockUntil === 'string' ? m.lockUntil : null,
    createdAt: String(m.createdAt ?? ''),
    lastLoginAt: typeof m.lastLoginAt === 'string' ? m.lastLoginAt : null,
  };
}

function memberProps(m: StoredMember): Record<string, string> {
  return { kind: 'member', nk: nameKey(m.name), active: m.active ? '1' : '0', phone: m.phone, last: m.lastLoginAt ?? '' };
}

function toDto(f: AppFile): MemberDto {
  const p = f.appProperties;
  return {
    id: f.id,
    name: f.name.replace(/\.json$/i, ''),
    phone: p.phone || '',
    active: p.active !== '0',
    createdAt: f.createdTime,
    lastLoginAt: p.last || null,
  };
}

async function findMembersFolder(): Promise<AppFile | null> {
  const files = await findFiles(
    `${q(ordersRootId())} in parents and mimeType = ${q(FOLDER_MIME)} and trashed = false and ` +
      `appProperties has { key='kind' and value='members' }`,
  );
  return files[0] ?? null;
}

async function memberFiles(folderId: string): Promise<AppFile[]> {
  return findFiles(`${q(folderId)} in parents and trashed = false and appProperties has { key='kind' and value='member' }`);
}

async function findMemberFile(name: string): Promise<AppFile | null> {
  const folder = await findMembersFolder();
  if (!folder) return null;
  const files = await findFiles(
    `${q(folder.id)} in parents and trashed = false and appProperties has { key='kind' and value='member' } and ` +
      `appProperties has { key='nk' and value=${q(nameKey(name))} }`,
  );
  return files[0] ?? null;
}

async function readMember(fileId: string): Promise<StoredMember> {
  return parseStored(await readJson(fileId));
}

async function writeMember(fileId: string, m: StoredMember, rename = false): Promise<AppFile> {
  return updateJsonFile(fileId, memberProps(m), m, rename ? m.name + '.json' : undefined);
}

/** A member file by id (admin actions). Deleted members are marked, since a trashed file can still be read. */
async function memberFile(rawId: unknown): Promise<AppFile> {
  const id = parseId(rawId);
  const notFound = () => new HttpError(404, 'המזמין לא נמצא ברשימה.', 'not_found');
  let file: AppFile;
  try {
    file = await getFile(id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw notFound();
    throw err;
  }
  if (file.appProperties.kind !== 'member') throw notFound();
  return file;
}

/** Order files (in every round) of the member: linked by id, or older ones still matched only by name. */
async function memberOrderFiles(id: string, name: string): Promise<AppFile[]> {
  const [linked, byName] = await Promise.all([
    findFiles(`trashed = false and appProperties has { key='mid' and value=${q(id)} }`),
    findFiles(
      `trashed = false and appProperties has { key='kind' and value='order' } and ` +
        `appProperties has { key='nk' and value=${q(nameKey(name))} }`,
    ),
  ]);
  return [...linked, ...byName.filter((f) => !f.appProperties.mid)];
}

// ── Sign-in ──

/** Checks the name and code against the list. The error doesn't tell whether the name is on the list. */
export async function memberLogin(name: string, pin: string): Promise<{ id: string; member: StoredMember }> {
  const wrong = () => new HttpError(401, 'השם או הקוד שגויים.', 'wrong_login');
  const file = await findMemberFile(name);
  if (!file) throw wrong();
  const m = await readMember(file.id);
  const now = Date.now();
  const lockUntil = Date.parse(m.lockUntil || '');
  if (lockUntil > now) {
    const minutes = Math.ceil((lockUntil - now) / 60000);
    throw new HttpError(429, `יותר מדי ניסיונות שגויים. נסו שוב בעוד ${minutes} דקות.`, 'too_many');
  }
  if (!m.pin || !checkPin(pin, m.pin)) {
    m.fails += 1;
    const blocked = m.fails >= MAX_FAILS;
    if (blocked) {
      m.fails = 0;
      m.lockUntil = new Date(now + LOCK_MS).toISOString();
    }
    await writeMember(file.id, m);
    if (blocked) throw new HttpError(429, 'יותר מדי ניסיונות שגויים. נסו שוב בעוד 15 דקות.', 'too_many');
    throw wrong();
  }
  if (!m.active) throw new HttpError(403, 'הגישה שלך להזמנות הושבתה. לפרטים פנו למנהל ההזמנות.', 'disabled');
  m.fails = 0;
  m.lockUntil = null;
  m.lastLoginAt = new Date(now).toISOString();
  await writeMember(file.id, m);
  return { id: file.id, member: m };
}

/** Part of the code's salt that goes into session tokens — a new code (new salt) ends existing sessions. */
export function sessionStamp(m: StoredMember): string {
  return m.pin ? m.pin.salt.slice(0, 8) : '';
}

/** The member of a session token, or null when it was removed, disabled or got a new code since. */
export async function sessionMember(id: string, stamp: string): Promise<StoredMember | null> {
  let m: StoredMember;
  try {
    m = await readMember(id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
  return m.active && m.pin && sessionStamp(m) === stamp ? m : null;
}

// ── Admin actions ──

export async function listMembers(): Promise<{ members: MemberDto[] }> {
  const folder = await findMembersFolder();
  const members = folder ? (await memberFiles(folder.id)).map(toDto) : [];
  members.sort((a, b) => a.name.localeCompare(b.name, 'he'));
  return { members };
}

/** Adds people to the list, each with a new code. Names already on the list (or invalid) are skipped. */
export async function addMembers(
  raw: unknown,
): Promise<{ added: IssuedCode[]; skipped: { name: string; reason: 'duplicate' | 'invalid' }[] }> {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_ADD) {
    throw new HttpError(400, `אפשר להוסיף עד ${MAX_ADD} מזמינים בכל פעם.`, 'bad_members');
  }
  const folder =
    (await findMembersFolder()) ?? (await createFolder('מזמינים', ordersRootId(), { kind: 'members' }));
  const taken = new Set((await memberFiles(folder.id)).map((f) => f.appProperties.nk));
  const skipped: { name: string; reason: 'duplicate' | 'invalid' }[] = [];
  const toAdd: { name: string; phone: string }[] = [];
  for (const entry of raw as Record<string, unknown>[]) {
    const rawName = typeof entry?.name === 'string' ? entry.name : '';
    let name: string;
    let phone: string;
    try {
      name = parseName(rawName);
      phone = parsePhone(entry.phone);
    } catch {
      skipped.push({ name: rawName.slice(0, 60), reason: 'invalid' });
      continue;
    }
    const nk = nameKey(name);
    if (taken.has(nk)) {
      skipped.push({ name, reason: 'duplicate' });
      continue;
    }
    taken.add(nk);
    toAdd.push({ name, phone });
  }

  const added: IssuedCode[] = [];
  // A few at a time keeps well within Drive's rate limits.
  for (let i = 0; i < toAdd.length; i += 6) {
    const batch = await Promise.all(
      toAdd.slice(i, i + 6).map(async ({ name, phone }) => {
        const code = generatePin();
        const m: StoredMember = {
          v: 1,
          name,
          phone,
          pin: hashPin(code),
          active: true,
          fails: 0,
          lockUntil: null,
          createdAt: new Date().toISOString(),
          lastLoginAt: null,
        };
        const file = await createJsonFile(folder.id, name + '.json', memberProps(m), m);
        return { member: toDto(file), code };
      }),
    );
    added.push(...batch);
  }
  return { added, skipped };
}

/** Renames (also in the member's orders), changes the phone, or disables/enables sign-in. */
export async function updateMember(
  rawId: unknown,
  patch: { name?: unknown; phone?: unknown; active?: unknown },
): Promise<{ member: MemberDto }> {
  const file = await memberFile(rawId);
  const m = await readMember(file.id);
  const oldName = m.name;
  if (patch.name !== undefined) m.name = parseName(patch.name);
  if (patch.phone !== undefined) m.phone = parsePhone(patch.phone);
  if (typeof patch.active === 'boolean') m.active = patch.active;

  const renamed = m.name !== oldName;
  if (renamed && nameKey(m.name) !== nameKey(oldName)) {
    const other = await findMemberFile(m.name);
    if (other && other.id !== file.id) throw new HttpError(409, 'כבר יש ברשימה מזמין בשם הזה.', 'duplicate');
  }
  if (renamed) {
    for (const f of await memberOrderFiles(file.id, oldName)) {
      const order = (await readJson(f.id)) as Record<string, unknown>;
      await updateJsonFile(f.id, { mid: file.id, nk: nameKey(m.name) }, { ...order, name: m.name }, m.name + '.json');
    }
  }
  return { member: toDto(await writeMember(file.id, m, renamed)) };
}

/** Issues a new code: the old one stops working and signed-in devices are signed out. */
export async function newCode(rawId: unknown): Promise<IssuedCode> {
  const file = await memberFile(rawId);
  const m = await readMember(file.id);
  const code = generatePin();
  m.pin = hashPin(code);
  m.fails = 0;
  m.lockUntil = null;
  return { member: toDto(await writeMember(file.id, m)), code };
}

/** Removes someone added by mistake. People who already ordered can only be disabled (their orders stay). */
export async function deleteMember(rawId: unknown): Promise<{ ok: true }> {
  const file = await memberFile(rawId);
  const m = await readMember(file.id);
  if ((await memberOrderFiles(file.id, m.name)).length) {
    throw new HttpError(409, 'יש למזמין הזמנות, ולכן אי אפשר למחוק אותו. אפשר להשבית אותו במקום.', 'has_orders');
  }
  // Mark first: a trashed file can still be read by id.
  await updateJsonFile(file.id, { kind: 'deleted', active: '0' }, { ...m, active: false });
  await trashFile(file.id);
  return { ok: true };
}

/** Names from orders of past rounds that are not on the list yet (to fill the list when starting out). */
export async function pastOrderers(): Promise<{ names: string[] }> {
  const [orders, { members }] = await Promise.all([
    findFiles(`trashed = false and appProperties has { key='kind' and value='order' }`),
    listMembers(),
  ]);
  const seen = new Set(members.map((m) => nameKey(m.name)));
  const names: string[] = [];
  for (const f of orders) {
    if (f.appProperties.mid) continue;
    const name = f.name.replace(/\.json$/i, '');
    const nk = nameKey(name);
    if (seen.has(nk)) continue;
    seen.add(nk);
    names.push(name);
  }
  names.sort((a, b) => a.localeCompare(b, 'he'));
  return { names };
}
