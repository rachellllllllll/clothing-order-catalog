/**
 * Server orders for Drive rounds: sign-in (name + PIN, before choosing a round), opening the order in each round,
 * debounced autosave, "send order", conflict handling between devices, and a local backup so edits survive being offline.
 */
import type { OrderLine, OrderResponse, SigninResponse } from '../../api/_types';
import { ApiError, apiPost } from '../lib/api/client';
import { linesKey, linesToQty, qtyToLines } from '../lib/catalog/draft';
import {
  readBackup,
  readStorage,
  useOrderStore,
  writeBackup,
  writeStorage,
  INITIAL_SYNC,
  type Account,
} from './orderStore';

type State = ReturnType<typeof useOrderStore.getState>;

const SAVE_DELAY_MS = 1500;
const RETRY_DELAY_MS = 15000;
const MEMBER_KEY = 'orderUi:member';

const get = useOrderStore.getState;
const set = useOrderStore.setState;

// ── Stored sign-in (one per device, for every round) ──

function readMember(): Account | null {
  try {
    const s = JSON.parse(readStorage(MEMBER_KEY) ?? 'null') as Account | null;
    return s && typeof s.name === 'string' && typeof s.token === 'string' ? s : null;
  } catch {
    return null;
  }
}

function writeMember(member: Account | null) {
  if (member) writeStorage(MEMBER_KEY, JSON.stringify(member));
  else {
    try {
      localStorage.removeItem(MEMBER_KEY);
    } catch {
      // ignore
    }
  }
}

set({ member: readMember() });

/** Which closed rounds the member ordered in (for the round list). */
async function loadOrderedRounds(member: Account) {
  set({ orderedRounds: 'pending' });
  let ordered: string[] | null = null;
  try {
    ordered = (await apiPost<{ ordered: string[] }>('/api/order', { action: 'myRounds' }, { token: member.token })).ordered;
  } catch {
    // Unknown: the list shows every round (an expired sign-in is handled when a round opens).
  }
  if (get().member === member) set({ orderedRounds: ordered });
}

if (typeof window !== 'undefined' && get().member) void loadOrderedRounds(get().member!);

/** Ends the sign-in on this device. The local backup keeps unsaved edits; they come back after signing in again. */
function dropMember(notice: string | null) {
  writeMember(null);
  set({
    member: null,
    orderedRounds: null,
    account: null,
    authPending: false,
    authNotice: notice,
    sync: INITIAL_SYNC,
    conflict: null,
    shortages: [],
    qty: {},
    missingNotice: null,
    lastRemoved: null,
    cartOpen: false,
  });
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
  } else if (e.status === 401) {
    dropMember(e.message);
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

  // A round opened: open the member's order in it.
  if (s.round && s.round.id !== prev.round?.id && s.source?.kind === 'drive') void openOrder();

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

  set({
    round,
    account: { name: server.name, token },
    authPending: false,
    authNotice: null,
    signer: server.name,
    qty,
    conflict,
    missingNotice: missing.length ? { origin: 'draft', lines: missing } : null,
    lastRemoved: null,
    sync: { ...INITIAL_SYNC, rev: server.rev, serverKey, submitted: server.submitted, savedAt: server.updatedAt },
    shortages: res.shortages ?? [],
  });
  if (lines !== server.lines) scheduleSave();
}

/** Signs in with the name and code from the orderers list, then opens the order in the open round (if any). */
export async function signIn(name: string, pin: string): Promise<void> {
  applySignin(await apiPost<SigninResponse>('/api/order', { action: 'signin', name, pin }));
}

function applySignin(res: SigninResponse) {
  const member = { name: res.name, token: res.token };
  writeMember(member);
  set({ member, authNotice: null, signer: res.name });
  void loadOrderedRounds(member);
  void openOrder();
}

/** The key of a personal sign-in link (`#login=<key>`), removed from the address so it isn't kept or shared. */
function takeLinkKey(): string | null {
  const key = /^#login=([\w.-]{1,500})$/.exec(window.location.hash)?.[1] ?? null;
  if (window.location.hash.startsWith('#login=')) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return key;
}

/** The member id inside a link or member token (readable without the secret) — only to compare two tokens. */
function tokenMember(token: string): string | null {
  try {
    const body = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const m = (JSON.parse(atob(body)) as { m?: unknown }).m;
    return typeof m === 'string' ? m : null;
  } catch {
    return null;
  }
}

/** Signs in with the personal link from the admin's mail — instead of whoever is signed in on this device. */
async function linkSignIn(key: string): Promise<void> {
  const before = get().member;
  if (!before) set({ authPending: true });
  try {
    const res = await apiPost<SigninResponse>('/api/order', { action: 'linkSignin', key });
    if (before && before.name !== res.name) {
      await saveNow();
      dropMember(null);
    }
    applySignin(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const current = get().member;
    const owner = tokenMember(key);
    // An old link of whoever is already signed in here: they are in their own account anyway.
    if (current && owner && tokenMember(current.token) === owner) return;
    // Someone else is signed in on this device: don't leave the link's owner ordering in their account.
    if (current) await saveNow();
    dropMember(message);
  }
}

if (typeof window !== 'undefined') {
  const key = takeLinkKey();
  if (key) void linkSignIn(key);
}

/** Opens the signed-in member's order in the open round (created on the first visit while the round is open). */
export async function openOrder(): Promise<void> {
  const { round, member, source } = get();
  if (!round || !member || source?.kind !== 'drive') return;
  const current = () => get().round?.id === round.id && get().member === member;
  set({ authPending: true, authNotice: null });
  try {
    const res = await apiPost<OrderResponse>('/api/order', { action: 'open', round: round.id }, { token: member.token });
    if (!current()) return;
    applyLogin(res, res.token!);
    if (res.created) get().setStatus('נפתחה לך הזמנה חדשה בסבב הזה.');
  } catch (err) {
    if (!current()) return;
    if (err instanceof ApiError && err.status === 401) dropMember(err.message);
    else set({ authPending: false, authNotice: err instanceof Error ? err.message : String(err) });
  }
}

/** Signs out on this device (e.g. so someone else can order), after saving. */
export async function logout(): Promise<void> {
  await saveNow();
  dropMember(null);
  set({ status: { message: '', isError: false } });
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
    get().setStatus(''); // the order bar shows it was sent
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
