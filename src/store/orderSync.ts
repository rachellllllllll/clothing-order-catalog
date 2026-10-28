/**
 * Server orders for Drive rounds: sign-in (name + PIN), debounced autosave, "send order",
 * conflict handling between devices, and a local backup so edits survive being offline.
 */
import type { OrderLine, OrderResponse } from '../../api/_types';
import { ApiError, apiPost } from '../lib/api/client';
import { linesKey, linesToQty, qtyToLines } from '../lib/catalog/draft';
import { readBackup, readStorage, unitsOf, useOrderStore, writeBackup, writeStorage, INITIAL_SYNC } from './orderStore';

type State = ReturnType<typeof useOrderStore.getState>;

const SAVE_DELAY_MS = 1500;
const RETRY_DELAY_MS = 15000;
const sessionKey = (roundId: string) => 'orderUi:session:' + roundId;

const get = useOrderStore.getState;
const set = useOrderStore.setState;

// ── Stored sessions (one per round, so each round remembers who signed in on this device) ──

export interface StoredSession {
  name: string;
  token: string;
}

export function readSession(roundId: string): StoredSession | null {
  try {
    const s = JSON.parse(readStorage(sessionKey(roundId)) ?? 'null') as StoredSession | null;
    return s && typeof s.name === 'string' && typeof s.token === 'string' ? s : null;
  } catch {
    return null;
  }
}

function writeSession(roundId: string, session: StoredSession | null) {
  if (session) writeStorage(sessionKey(roundId), JSON.stringify(session));
  else {
    try {
      localStorage.removeItem(sessionKey(roundId));
    } catch {
      // ignore
    }
  }
}

// ── Helpers ──

function currentLines(s: State): OrderLine[] {
  return s.catalog ? qtyToLines(s.catalog, s.qty) : [];
}

/** True when the shown order has changes the server doesn't have yet. */
export function hasUnsavedChanges(s: State): boolean {
  return !!s.account && !s.conflict && linesKey(currentLines(s)) !== s.sync.serverKey;
}

/** True when the shown order differs from the last sent version (or was never sent). */
export function hasUnsentChanges(s: State): boolean {
  if (!s.sync.submitted) return true;
  return linesKey(currentLines(s)) !== linesKey(s.sync.submitted.lines);
}

function canSave(s: State): boolean {
  return !!(s.account && s.catalog && s.source?.kind === 'drive' && s.round && !s.conflict) && !isLocked(s);
}

function isLocked(s: State): boolean {
  return !!s.round && (s.round.locked || s.round.archived);
}

function backup(s: State) {
  if (!s.account || !s.source) return;
  const lines = currentLines(s);
  writeBackup(s.source.catalogKey, s.account.name, {
    updatedAt: new Date().toISOString(),
    lines,
    baseRev: s.sync.rev,
    dirty: linesKey(lines) !== s.sync.serverKey,
  });
}

/** Applies a server answer, unless the user meanwhile switched round or signed out. */
function applyServer(snap: State, res: OrderResponse) {
  const s = get();
  if (s.source !== snap.source || s.account?.token !== snap.account?.token) return;
  set({
    round: s.round ? { ...s.round, ...res.round } : s.round,
    sync: {
      rev: res.order.rev,
      serverKey: linesKey(res.order.lines),
      submitted: res.order.submitted,
      status: 'saved',
      error: null,
      savedAt: res.order.updatedAt,
    },
  });
  backup(get());
}

function handleError(snap: State, err: unknown, mine: OrderLine[]) {
  const s = get();
  if (s.source !== snap.source || s.account?.token !== snap.account?.token) return;
  const e = err instanceof ApiError ? err : new ApiError(0, String(err));
  if (e.code === 'conflict' && e.data.order) {
    set({ conflict: { server: e.data.order as OrderResponse['order'], mine }, sync: { ...s.sync, status: 'idle' } });
  } else if (e.code === 'locked' && s.round) {
    set({
      round: { ...s.round, ...(e.data.round as object) },
      sync: { ...s.sync, status: 'error', error: 'השינויים האחרונים לא נשמרו: ' + e.message },
    });
  } else if (e.status === 401 && s.round) {
    // The local backup keeps the edits; they come back after signing in again.
    writeSession(s.round.id, null);
    set({ account: null, sync: INITIAL_SYNC, conflict: null, qty: {}, authNotice: e.message });
  } else {
    set({ sync: { ...s.sync, status: 'error', error: e.message } });
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => void saveNow(), RETRY_DELAY_MS);
  }
}

// ── Autosave ──

let saveTimer: number | undefined;
let retryTimer: number | undefined;
let inFlight: Promise<void> | null = null;

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), SAVE_DELAY_MS);
}

/** Saves the given state's order if it changed. Waits for a save already in flight first. */
export async function saveNow(snap: State = get(), keepalive = false): Promise<void> {
  window.clearTimeout(saveTimer);
  window.clearTimeout(retryTimer);
  while (inFlight) await inFlight;
  if (snap === undefined || !canSave(snap)) return;
  // Re-read: the state may have moved on while waiting (unless saving an old snapshot on round switch).
  const s = snap.source === get().source && snap.account === get().account ? get() : snap;
  if (!hasUnsavedChanges(s)) return;

  const lines = currentLines(s);
  if (s === get()) set({ sync: { ...s.sync, status: 'saving' } });
  inFlight = (async () => {
    try {
      const res = await apiPost<OrderResponse>(
        '/api/order',
        { action: 'save', lines, baseRev: s.sync.rev },
        { token: s.account!.token, keepalive },
      );
      applyServer(s, res);
    } catch (err) {
      handleError(s, err, lines);
    } finally {
      inFlight = null;
    }
  })();
  await inFlight;
  // Edits made while saving.
  if (hasUnsavedChanges(get()) && get().sync.status === 'saved') scheduleSave();
}

useOrderStore.subscribe((s, prev) => {
  // Leaving a round (switch / local folder) with unsaved edits: save the old state right away.
  if (s.source !== prev.source && prev.account && hasUnsavedChanges(prev)) void saveNow(prev, true);

  // A round opened: sign in again with the stored session.
  if (s.round && s.round.id !== prev.round?.id && s.source?.kind === 'drive') void resumeSession();

  if (s.account && s.account === prev.account && s.source === prev.source && s.qty !== prev.qty) {
    backup(s);
    if (canSave(s)) scheduleSave();
  }
});

if (typeof window !== 'undefined') {
  // Last chance to save when the tab is hidden or closed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && hasUnsavedChanges(get())) void saveNow(get(), true);
  });
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedChanges(get()) && canSave(get())) e.preventDefault();
  });
  window.addEventListener('online', () => {
    if (hasUnsavedChanges(get())) void saveNow();
  });
}

// ── Sign-in ──

function applyLogin(res: OrderResponse, token: string) {
  const s = get();
  if (!s.catalog || !s.source || !s.round) return;
  const round = { ...s.round, ...res.round };
  const server = res.order;
  const serverKey = linesKey(server.lines);
  const local = readBackup(s.source.catalogKey, server.name);
  const readOnly = round.locked || round.archived;

  // Edits saved only on this device (e.g. the tab closed while offline).
  let lines = server.lines;
  let conflict = null;
  if (!readOnly && local?.dirty && linesKey(local.lines) !== serverKey) {
    if (local.baseRev === server.rev) lines = local.lines;
    else conflict = { server, mine: local.lines };
  }
  const { qty, missing } = linesToQty(s.catalog, conflict ? conflict.mine : lines);
  const units = unitsOf(qty);

  set({
    round,
    account: { name: server.name, token },
    authPending: false,
    authNotice: null,
    signer: server.name,
    qty,
    conflict,
    missingNotice: missing.length ? { origin: 'draft', lines: missing } : null,
    resumeNotice: units > 0 && !conflict ? { units, updatedAt: server.updatedAt } : null,
    lastRemoved: null,
    sync: { ...INITIAL_SYNC, rev: server.rev, serverKey, submitted: server.submitted, savedAt: server.updatedAt },
  });
  writeSession(round.id, { name: server.name, token });
  if (lines !== server.lines) scheduleSave();
}

export type LoginResult = 'ok' | 'not_found';

/** Signs in to the open round. 'not_found' means no order with this name yet — ask, then call with create. */
export async function login(name: string, pin: string, create = false): Promise<LoginResult> {
  const round = get().round;
  if (!round) return 'ok';
  try {
    const res = await apiPost<OrderResponse>('/api/order', { action: 'login', round: round.id, name, pin, create });
    if (get().round?.id !== round.id) return 'ok';
    applyLogin(res, res.token!);
    if (res.pinSet) {
      get().setStatus(create ? 'נפתחה הזמנה חדשה. זכרו את הקוד — תצטרכו אותו בכניסה הבאה.' : 'נקבע קוד חדש להזמנה שלך.');
    }
    return 'ok';
  } catch (err) {
    if (err instanceof ApiError && err.code === 'not_found') return 'not_found';
    throw err;
  }
}

async function resumeSession() {
  const round = get().round;
  const session = round && readSession(round.id);
  if (!round || !session) return;
  set({ authPending: true, authNotice: null });
  try {
    const res = await apiPost<OrderResponse>('/api/order', { action: 'load' }, { token: session.token });
    if (get().round?.id === round.id) applyLogin(res, session.token);
  } catch (err) {
    if (get().round?.id !== round.id) return;
    if (err instanceof ApiError && err.status === 401) writeSession(round.id, null);
    set({ authPending: false, authNotice: err instanceof Error ? err.message : String(err) });
  }
}

export async function logout(): Promise<void> {
  await saveNow();
  const s = get();
  if (s.round) writeSession(s.round.id, null);
  set({
    account: null,
    sync: INITIAL_SYNC,
    conflict: null,
    qty: {},
    resumeNotice: null,
    missingNotice: null,
    lastRemoved: null,
    cartOpen: false,
    status: { message: '', isError: false },
  });
}

// ── Send ──

/** Saves and marks the current version as sent. Returns false (with the reason in the status line) on failure. */
export async function submitOrder(): Promise<boolean> {
  window.clearTimeout(saveTimer);
  while (inFlight) await inFlight;
  const s = get();
  if (!canSave(s)) return false;
  const lines = currentLines(s);
  set({ sync: { ...s.sync, status: 'saving' } });
  try {
    const res = await apiPost<OrderResponse>(
      '/api/order',
      { action: 'submit', lines, baseRev: s.sync.rev },
      { token: s.account!.token },
    );
    applyServer(s, res);
    get().setStatus('ההזמנה נשלחה ✓ אפשר לחזור ולעדכן אותה עד שהסבב ייסגר.');
    return true;
  } catch (err) {
    handleError(s, err, lines);
    if (!get().conflict) get().setStatus('שליחת ההזמנה נכשלה: ' + (err instanceof Error ? err.message : String(err)), true);
    return false;
  }
}

// ── Conflicts ──

export function resolveConflict(keep: 'mine' | 'server') {
  const s = get();
  if (!s.conflict || !s.catalog) return;
  const { server, mine } = s.conflict;
  const base = { rev: server.rev, serverKey: linesKey(server.lines), submitted: server.submitted, savedAt: server.updatedAt };
  if (keep === 'server') {
    const { qty, missing } = linesToQty(s.catalog, server.lines);
    set({
      conflict: null,
      qty,
      missingNotice: missing.length ? { origin: 'draft', lines: missing } : null,
      sync: { ...s.sync, ...base, status: 'idle', error: null },
    });
  } else {
    const { qty } = linesToQty(s.catalog, mine);
    set({ conflict: null, qty, sync: { ...s.sync, ...base, status: 'idle', error: null } });
  }
  backup(get());
  void saveNow();
}
