import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { OrderDto, OrderSummary, RoundState, ShortageChange, Shortages } from '../../api/_types';
import { ApiError, apiPost } from '../lib/api/client';
import {
  addTotals,
  emptyTotals,
  isChangedAfterSend,
  linesTotals,
  matchesStatus,
  productsView,
  sentLines,
  type StatusFilter,
  type Totals,
  unsentNote,
  unsentUnits,
} from '../lib/catalog/adminView';
import { formatDay, formatSavedAt, todayKey, toMoney } from '../lib/catalog/text';
import type { Catalog } from '../lib/catalog/types';
import { loadDriveCatalog } from '../lib/source/drive';
import type { CatalogSource, Round } from '../lib/source/types';
import { AnnounceMail, type Kind } from './AnnounceMail';
import { CatalogEditor } from './CatalogEditor';
import { OrderersTable } from './OrderersTable';
import { ProductsTable } from './ProductsTable';

export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Tab = 'orderers' | 'products' | 'catalog';

/** How often an open round re-checks the orders while the page is visible. */
const POLL_MS = 30_000;
/** Above this many changed orders, one bulk download is cheaper than fetching each order. */
const MAX_SINGLE_FETCHES = 5;

const isStale = (s: OrderSummary, o: OrderDto | undefined) =>
  !o || o.rev !== s.rev || (o.submitted?.at ?? null) !== s.submittedAt;

/** Everything the views are computed from: all orders with their lines, and the round's catalog. */
interface RoundData {
  orders: Map<string, OrderDto>;
  /** Units that did not arrive from the supplier, per order file id. */
  shortages: Shortages;
  catalog: Catalog;
  source: CatalogSource;
  loadedAt: string;
}

interface RoundAdminProps {
  round: Round;
  onRoundChange: (id: string, patch: Partial<Round>) => void;
  onDeleted: (id: string) => void;
  onSignedOut: () => void;
}

export function RoundAdmin({ round, onRoundChange, onDeleted, onSignedOut }: RoundAdminProps) {
  const [summaries, setSummaries] = useState<OrderSummary[] | null>(null);
  const [data, setData] = useState<RoundData | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: '' });
  const [busy, setBusy] = useState(false);
  // A draft has no orders yet: it opens in its catalog editor.
  const [tab, setTab] = useState<Tab>(round.draft ? 'catalog' : 'orderers');
  const [editorDirty, setEditorDirty] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [receiving, setReceiving] = useState(false);
  const [announcing, setAnnouncing] = useState(false);
  // Right after publishing, the message to send is the opening one; for a round already open, a reminder.
  const [announceKind, setAnnounceKind] = useState<Kind>('reminder');
  const canMark = round.locked || round.archived;
  const receivingOn = receiving && canMark && tab === 'products';

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setStatus({ text: errText(err), error: true });
    },
    [onSignedOut],
  );

  // The cheap summaries show first; full orders and the catalog follow in parallel. Only the round id is
  // used, so updating the round's state (lock/archive) doesn't reload.
  const refresh = useCallback(async () => {
    setLoading(true);
    const full = Promise.all([
      apiPost<{ orders: { fileId: string; order: OrderDto }[]; shortages: Shortages }>('/api/admin', {
        action: 'allOrders',
        round: round.id,
      }),
      loadDriveCatalog(round, { admin: true }).then((source) => ({ source, catalog: source.catalog })),
    ]);
    full.catch(() => undefined);
    try {
      const res = await apiPost<{ round: RoundState; orders: OrderSummary[] }>('/api/admin', { action: 'orders', round: round.id });
      setSummaries(res.orders);
      onRoundChange(round.id, res.round);
      const [{ orders, shortages }, cat] = await full;
      setData({
        orders: new Map(orders.map((o) => [o.fileId, o.order])),
        shortages,
        ...cat,
        loadedAt: new Date().toISOString(),
      });
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
  }, [round.id, onRoundChange, fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  const syncing = useRef(false);

  // Background check: the cheap summaries tell which orders changed; only those are downloaded again.
  const sync = useCallback(async () => {
    const cur = dataRef.current;
    if (!cur || syncing.current) return;
    syncing.current = true;
    try {
      const res = await apiPost<{ round: RoundState; orders: OrderSummary[] }>('/api/admin', { action: 'orders', round: round.id });
      setSummaries(res.orders);
      onRoundChange(round.id, res.round);
      const changed = res.orders.filter((s) => isStale(s, cur.orders.get(s.fileId)));
      let fresh: { fileId: string; order: OrderDto }[] = [];
      let shortages: Shortages | undefined;
      if (changed.length > MAX_SINGLE_FETCHES) {
        ({ orders: fresh, shortages } = await apiPost<{ orders: { fileId: string; order: OrderDto }[]; shortages: Shortages }>(
          '/api/admin',
          { action: 'allOrders', round: round.id },
        ));
      } else if (changed.length) {
        fresh = await Promise.all(
          changed.map(async ({ fileId }) => {
            const r = await apiPost<{ order: OrderDto }>('/api/admin', { action: 'order', round: round.id, fileId });
            return { fileId, order: r.order };
          }),
        );
      }
      const ids = new Set(res.orders.map((s) => s.fileId));
      setData((d) => {
        if (!d) return d;
        const orders = new Map([...d.orders].filter(([id]) => ids.has(id)));
        for (const f of fresh) orders.set(f.fileId, f.order);
        return { ...d, orders, shortages: shortages ?? d.shortages, loadedAt: new Date().toISOString() };
      });
    } catch (err) {
      // A missed check is retried on the next tick; only a lost admin session needs handling.
      if (err instanceof ApiError && err.status === 401) onSignedOut();
    } finally {
      syncing.current = false;
    }
  }, [round.id, onRoundChange, onSignedOut]);

  // Orders change only while the round is open; a hidden tab doesn't poll and checks once it is shown again.
  const open = !round.locked && !round.archived;
  useEffect(() => {
    if (!open) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void sync();
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [open, sync]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setStatus({ text: '' });
    try {
      await action();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const saveRound = (patch: Partial<RoundState>) =>
    run(async () => {
      const res = await apiPost<{ round: RoundState }>('/api/admin', { action: 'setRound', round: round.id, ...patch });
      onRoundChange(round.id, res.round);
    });

  const setRound = (patch: Partial<RoundState>, question: string) => window.confirm(question) && saveRound(patch);

  const publish = () =>
    window.confirm(`לפרסם את הסבב "${round.name}"? המזמינים יראו אותו מיד ויוכלו להזמין.`) &&
    run(async () => {
      await apiPost('/api/admin', { action: 'publishRound', round: round.id });
      onRoundChange(round.id, { draft: undefined });
      setTab('orderers');
      setAnnounceKind('open');
      setAnnouncing(true);
      setStatus({ text: 'הסבב פורסם — המזמינים רואים אותו עכשיו. אפשר לשלוח להם הודעה במייל.' });
    });

  const deleteRound = () =>
    window.confirm(`למחוק את הסבב "${round.name}"? הקטלוג והתמונות שלו יעברו לאשפה של Google Drive.`) &&
    run(async () => {
      await apiPost('/api/admin', { action: 'deleteRound', round: round.id });
      onDeleted(round.id);
    });

  const markShortages = (changes: ShortageChange[]) =>
    changes.length > 0 &&
    run(async () => {
      const res = await apiPost<{ shortages: Shortages }>('/api/admin', { action: 'setShortages', round: round.id, changes });
      setData((d) => d && { ...d, shortages: res.shortages });
    });

  // Every total counts the sent version only: it is what is ordered from the supplier and charged.
  const totals = useMemo(() => {
    if (!data) return null;
    const map = new Map<string, Totals>();
    for (const [fileId, order] of data.orders) {
      map.set(fileId, linesTotals(data.catalog, sentLines(order), data.shortages[fileId]));
    }
    return map;
  }, [data]);

  const products = useMemo(() => (data ? productsView(data.catalog, data.orders, data.shortages) : null), [data]);

  const count = (f: StatusFilter) => summaries?.filter((o) => matchesStatus(o, f)).length ?? 0;
  let sum: Totals | null = null;
  if (totals) {
    sum = emptyTotals();
    for (const t of totals.values()) addTotals(sum, t);
  }

  const query = search.trim().toLowerCase();
  const visibleOrderers =
    summaries?.filter((o) => matchesStatus(o, filter) && (!query || o.name.toLowerCase().includes(query))) ?? null;

  const filters: [StatusFilter, string, boolean][] = [
    ['all', 'כולם', false],
    ['sent', 'שלחו', false],
    ['unsent', 'לא שלחו', !round.locked && !round.archived],
    ['changed', 'שונו אחרי שליחה', true],
  ];

  // What the sent totals don't show: units not sent yet, and units removed after sending that are still counted.
  // Only while the round is open: once locked, what was sent is final and unsent carts no longer matter.
  const unsent = summaries && totals ? unsentUnits(summaries, (o) => totals.get(o.fileId)?.units) : null;
  const pendingNote = open && unsent ? unsentNote(unsent) : '';
  // Locking makes the sent versions final, so it first lists what would be left out (or still counted).
  const lockQuestion = () => {
    const base = 'לנעול את הסבב? המזמינים יוכלו רק לצפות בהזמנות.';
    const who = summaries?.filter((o) => (!o.submittedAt && o.units > 0) || isChangedAfterSend(o)).map((o) => o.name) ?? [];
    if (!unsent || (!unsent.added && !unsent.removed) || !who.length) return base;
    const names = who.slice(0, 10).join(', ') + (who.length > 10 ? ` ועוד ${who.length - 10}` : '');
    return [
      '⚠ יש מזמינים עם פריטים בסל שלא נשלחו. בהזמנה מהספק נכלל רק מה שנשלח:',
      unsent.added > 0 && `• ${unsent.added} יח׳ שלא נשלחו — לא ייכללו`,
      unsent.removed > 0 && `• ${unsent.removed} יח׳ שהוסרו אחרי השליחה — עדיין ייכללו`,
      `מזמינים (${who.length}): ${names}`,
      'אפשר לבטל ולשלוח להם קודם תזכורת (✉ הודעה למזמינים).',
      '',
      'לנעול את הסבב בכל זאת? המזמינים יוכלו רק לצפות בהזמנות.',
    ]
      .filter((l) => l !== false)
      .join('\n');
  };
  const sentOnly = 'רק הזמנות שנשלחו — מה שמוזמן מהספק. טיוטות ושינויים שלא נשלחו לא נספרים.';
  // The closing date only reminds the admin: the round stays open until it is locked by hand.
  const today = todayKey();
  const closingDue = open && !!round.closesOn && round.closesOn <= today;
  // A round created here can be deleted until someone orders in it (then it can only be archived).
  const canDelete = round.editable && !!summaries && summaries.every((s) => !s.units && !s.submittedAt);
  const deleteButton = canDelete && (
    <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void deleteRound()}>
      🗑 מחיקת הסבב
    </button>
  );
  const editor = round.editable && (
    <CatalogEditor
      round={round}
      hidden={tab !== 'catalog'}
      orders={data?.orders ?? null}
      onSaved={(name) => {
        if (name !== round.name) onRoundChange(round.id, { name });
        void refresh();
      }}
      onDirtyChange={setEditorDirty}
      onSignedOut={onSignedOut}
    />
  );

  if (round.draft) {
    return (
      <>
        <section className="panel admin-status">
          <div className="admin-status-head">
            <RoundSteps round={round} receiving={false} hint="המזמינים לא רואים את הסבב עד שתפרסמו אותו." />
            <div className="admin-actions admin-status-actions">
              <a
                className="btn-secondary btn-sm"
                href={'/?round=' + encodeURIComponent(round.id) + '&preview'}
                target="_blank"
                rel="noopener"
                title={editorDirty ? 'התצוגה מראה רק מה שנשמר' : undefined}
              >
                👁 תצוגה כמו מזמין
              </a>
              <button
                type="button"
                className="btn-primary btn-sm"
                disabled={busy || editorDirty}
                title={editorDirty ? 'שמרו קודם את השינויים' : undefined}
                onClick={() => void publish()}
              >
                📢 פרסום למזמינים
              </button>
              {deleteButton}
            </div>
          </div>
          {status.text && <div className={'status' + (status.error ? ' error' : '')}>{status.text}</div>}
        </section>
        <section className="panel admin-main">{editor}</section>
      </>
    );
  }

  return (
    <>
      <section className="panel admin-status">
        <div className="admin-status-head">
          <RoundSteps
            round={round}
            receiving={receivingOn || !!sum?.missingUnits}
            hint={
              round.archived
                ? 'מוצג למזמינים בארכיון, לצפייה בלבד.'
                : round.locked
                  ? 'המזמינים יכולים רק לצפות. כשהסחורה מגיעה — "קבלת סחורה" לסימון מה שלא הגיע; בסוף — לארכיון.'
                  : 'המזמינים יכולים לערוך ולשלוח. בסוף ההזמנות — נעילת הסבב.'
            }
          />
          <div className="admin-kpis">
            <span className="admin-kpi">
              <span className="t">שלחו הזמנה</span>
              <span className="v">
                {summaries ? (
                  <>
                    {count('sent')}
                    <span className="admin-kpi-of">/{count('all')}</span>
                  </>
                ) : (
                  '…'
                )}
              </span>
            </span>
            <span className="admin-kpi" title={sentOnly}>
              <span className="t">יחידות</span>
              <span className="v">{sum ? sum.units : '…'}</span>
              {pendingNote && <span className="small admin-pending">{pendingNote}</span>}
            </span>
            <span className="admin-kpi" title={sentOnly}>
              <span className="t">{sum?.missingUnits ? 'לתשלום' : 'סכום'}</span>
              <span className="v">{sum ? toMoney(sum.amount) : '…'}</span>
              {sum && sum.unpricedUnits > 0 && <span className="small danger">+{sum.unpricedUnits} יח׳ ללא מחיר</span>}
            </span>
            {sum && sum.missingUnits > 0 && (
              <span className="admin-kpi warn" title={`${toMoney(sum.missingAmount)} שלא יחויבו`}>
                <span className="v">{sum.missingUnits}</span>
                <span className="t">לא הגיעו · {toMoney(sum.missingAmount)}</span>
              </span>
            )}
          </div>
          <div className="admin-actions admin-status-actions">
            {open && <ClosingDate closesOn={round.closesOn} busy={busy} onSave={(closesOn) => void saveRound({ closesOn })} />}
            {round.archived ? (
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={busy}
                onClick={() => setRound({ archived: false, locked: true }, 'להחזיר את הסבב מהארכיון? הוא יחזור להיות נעול.')}
              >
                החזרה מהארכיון
              </button>
            ) : (
              <>
                {!round.locked && (
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    aria-pressed={announcing}
                    disabled={editorDirty && !announcing}
                    title={editorDirty ? 'שמרו קודם את השינויים בקטלוג' : 'טיוטת מייל לכל מזמין, עם הקישור האישי שלו'}
                    onClick={() => setAnnouncing((a) => !a)}
                  >
                    ✉ הודעה למזמינים
                  </button>
                )}
                {round.locked ? (
                  <>
                    {!receivingOn && (
                      <button
                        type="button"
                        className="btn-primary btn-sm"
                        title="סימון מה שלא הגיע מהספק — המזמינים לא יחויבו עליו"
                        onClick={() => {
                          setTab('products');
                          setReceiving(true);
                        }}
                      >
                        📦 קבלת סחורה
                      </button>
                    )}
                    <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setRound({ locked: false }, 'לפתוח את הסבב לשינויים?')}>
                      🔓 פתיחה מחדש
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      disabled={busy}
                      onClick={() => setRound({ archived: true }, 'להעביר את הסבב לארכיון? הוא יוצג למזמינים לצפייה בלבד.')}
                    >
                      🗄 לארכיון
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => setRound({ locked: true }, lockQuestion())}
                  >
                    🔒 נעילת הסבב
                  </button>
                )}
              </>
            )}
            {deleteButton}
          </div>
        </div>
        {closingDue && (
          <div className="admin-closing-due" role="alert">
            ⏰{' '}
            {round.closesOn === today
              ? 'היום היום האחרון להזמנות — בסוף היום צריך לנעול את הסבב.'
              : `תאריך הסגירה (${formatDay(round.closesOn!)}) עבר והסבב עדיין פתוח — המזמינים עדיין יכולים לשנות ולשלוח. צריך לנעול אותו.`}
          </div>
        )}
        {status.text && <div className={'status' + (status.error ? ' error' : '')}>{status.text}</div>}
      </section>

      {announcing && !round.locked && !round.archived ? (
        <AnnounceMail
          round={round}
          summaries={summaries}
          initialKind={announceKind}
          onClose={() => setAnnouncing(false)}
          onSignedOut={onSignedOut}
        />
      ) : (
        <section className="panel admin-main">
          <div className="admin-toolbar">
            <div className="admin-seg" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'orderers'} onClick={() => setTab('orderers')}>
                לפי מזמינים
              </button>
              <button type="button" role="tab" aria-selected={tab === 'products'} onClick={() => setTab('products')}>
                לפי מוצרים
              </button>
              {round.editable && (
                <button type="button" role="tab" aria-selected={tab === 'catalog'} onClick={() => setTab('catalog')}>
                  עריכת קטלוג{editorDirty && ' ●'}
                </button>
              )}
            </div>
            {tab !== 'catalog' && (
              <>
                <input
                  type="search"
                  className="admin-search"
                  placeholder={tab === 'orderers' ? 'חיפוש מזמין…' : 'חיפוש דגם, צבע או מזמין…'}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {tab === 'orderers' && !!summaries?.length && (
                  <div className="admin-filter" role="group" aria-label="סינון לפי מצב ההזמנה">
                    {filters.map(([f, label, warn]) => (
                      <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                        {label} <span className={'admin-filter-n' + (warn && count(f) ? ' warn' : '')}>{count(f)}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="admin-toolbar-end">
                  <button type="button" className="btn-secondary btn-sm" disabled={loading} onClick={() => void refresh()} title="טעינה מחדש של ההזמנות והקטלוג">
                    ↻ {loading ? 'טוען…' : 'רענון'}
                  </button>
                  {data && <span className="muted small">נטען {formatSavedAt(data.loadedAt)}</span>}
                </div>
              </>
            )}
          </div>

          {editor}
          {tab === 'catalog' ? null : tab === 'orderers' ? (
            !visibleOrderers ? (
              <div className="muted">טוען…</div>
            ) : !summaries?.length ? (
              <div className="muted">עדיין אין הזמנות בסבב הזה.</div>
            ) : (
              <OrderersTable
                rows={visibleOrderers}
                totals={totals}
                final={!open}
                detail={data && { orders: data.orders, shortages: data.shortages, catalog: data.catalog, images: data.source.images }}
              />
            )
          ) : !data || !products ? (
            <div className="muted">טוען הזמנות וקטלוג…</div>
          ) : (
            <ProductsTable
              view={products}
              images={data.source.images}
              query={query}
              canMark={canMark}
              receiving={receivingOn}
              onReceivingChange={setReceiving}
              busy={busy}
              onMark={(changes) => void markShortages(changes)}
            />
          )}
        </section>
      )}
    </>
  );
}

interface ClosingDateProps {
  closesOn: string | null;
  busy: boolean;
  onSave: (closesOn: string | null) => void;
}

/** The planned last day for orders. It only reminds the admin to lock the round — nothing closes by itself. */
function ClosingDate({ closesOn, busy, onSave }: ClosingDateProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  if (!editing) {
    return (
      <button
        type="button"
        className="btn-link small"
        title="היום האחרון להזמנות: תזכורת לנעול את הסבב (הסבב לא ננעל לבד). מופיע גם במיילים למזמינים."
        onClick={() => {
          setValue(closesOn ?? '');
          setEditing(true);
        }}
      >
        📅 {closesOn ? 'הזמנות עד ' + formatDay(closesOn) : 'קביעת תאריך סגירה'}
      </button>
    );
  }

  const save = (day: string | null) => {
    setEditing(false);
    if (day !== closesOn) onSave(day);
  };
  return (
    <span className="admin-closing">
      <label className="small" htmlFor="roundClosesOn">
        הזמנות עד
      </label>
      <input id="roundClosesOn" type="date" value={value} min={todayKey()} onChange={(e) => setValue(e.target.value)} />
      <button type="button" className="btn-primary btn-sm" disabled={busy || !value} onClick={() => save(value)}>
        שמירה
      </button>
      {closesOn && (
        <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => save(null)}>
          הסרת התאריך
        </button>
      )}
      <button type="button" className="btn-link small" onClick={() => setEditing(false)}>
        ביטול
      </button>
    </span>
  );
}

/** Where the round is in its life: draft → open → locked → receiving the goods → archive. */
function RoundSteps({ round, receiving, hint }: { round: Round; receiving: boolean; hint: string }) {
  const steps = [...(round.editable ? ['טיוטה'] : []), 'פתוח להזמנות', 'נעול', 'קבלת סחורה', 'ארכיון'];
  const current = steps.indexOf(
    round.draft
      ? 'טיוטה'
      : round.archived
        ? 'ארכיון'
        : round.locked
          ? receiving
            ? 'קבלת סחורה'
            : 'נעול'
          : 'פתוח להזמנות',
  );
  return (
    <ol className="admin-steps" aria-label="שלב הסבב">
      {steps.map((s, i) => (
        <li key={s} className={i < current ? 'done' : undefined} aria-current={i === current ? 'step' : undefined}>
          {i < current && '✓ '}
          {s}
          {i === current && <InfoTip text={hint} />}
        </li>
      ))}
    </ol>
  );
}

/** ⓘ with a short explanation: shown on hover or keyboard focus, and pinned open by a click (touch screens). */
function InfoTip({ text }: { text: string }) {
  // 'peek' follows hover/keyboard focus; 'pinned' stays until a click elsewhere or Escape.
  const [shown, setShown] = useState<'off' | 'peek' | 'pinned'>('off');
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  const open = shown !== 'off';
  const unpeek = () => setShown((s) => (s === 'peek' ? 'off' : s));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setShown('off');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShown('off');
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span
      className={'admin-info' + (open ? ' open' : '')}
      ref={ref}
      onMouseEnter={() => setShown((s) => (s === 'off' ? 'peek' : s))}
      onMouseLeave={unpeek}
    >
      <button
        type="button"
        className="admin-info-btn"
        aria-label="הסבר על השלב"
        aria-expanded={open}
        aria-describedby={id}
        onFocus={(e) => e.currentTarget.matches(':focus-visible') && setShown((s) => (s === 'off' ? 'peek' : s))}
        onBlur={unpeek}
        onClick={() => setShown((s) => (s === 'pinned' ? 'off' : 'pinned'))}
      >
        ⓘ
      </button>
      <span role="tooltip" id={id} className="admin-info-pop">
        {text}
      </span>
    </span>
  );
}
