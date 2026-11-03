import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
} from '../lib/catalog/adminView';
import { formatSavedAt, signed, toMoney } from '../lib/catalog/text';
import type { Catalog } from '../lib/catalog/types';
import { loadDriveCatalog } from '../lib/source/drive';
import type { CatalogSource, Round } from '../lib/source/types';
import { AnnounceMail } from './AnnounceMail';
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

  const setRound = (patch: Partial<RoundState>, question: string) =>
    window.confirm(question) &&
    run(async () => {
      const res = await apiPost<{ round: RoundState }>('/api/admin', { action: 'setRound', round: round.id, ...patch });
      onRoundChange(round.id, res.round);
    });

  const publish = () =>
    window.confirm(`לפרסם את הסבב "${round.name}"? המזמינים יראו אותו מיד ויוכלו להזמין.`) &&
    run(async () => {
      await apiPost('/api/admin', { action: 'publishRound', round: round.id });
      onRoundChange(round.id, { draft: undefined });
      setTab('orderers');
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

  const pickFilter = (f: StatusFilter) => {
    setAnnouncing(false);
    setTab('orderers');
    setFilter((cur) => (cur === f && f !== 'all' ? 'all' : f));
  };

  const showProducts = () => {
    setAnnouncing(false);
    setTab('products');
  };

  const kpi = (f: StatusFilter, label: string, value: number, warn = false) => (
    <button
      type="button"
      className={'admin-kpi' + (warn && value ? ' warn' : '')}
      aria-pressed={!announcing && tab === 'orderers' && filter === f}
      onClick={() => pickFilter(f)}
    >
      <span className="t">{label}</span>
      <span className="v">{summaries ? value : '…'}</span>
    </button>
  );

  // What is left out of the totals: units in drafts never sent, and the net change of orders edited after sending.
  let draftUnits = 0;
  let drafts = 0;
  let changedUnits = 0;
  for (const o of summaries ?? []) {
    if (!o.submittedAt) {
      draftUnits += o.units;
      if (o.units) drafts++;
    } else if (isChangedAfterSend(o) && totals?.get(o.fileId)) changedUnits += o.units - totals.get(o.fileId)!.units;
  }
  const pendingNote = [
    draftUnits && `${draftUnits} ${drafts === 1 ? 'בטיוטה' : 'בטיוטות'}`,
    changedUnits && `${signed(changedUnits)} בשינויים`,
  ]
    .filter(Boolean)
    .join(' · ');
  const sentOnly = 'רק הזמנות שנשלחו — מה שמוזמן מהספק. טיוטות ושינויים שלא נשלחו לא נספרים.';
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
            <span className="chip chip-warn">טיוטה</span>
            <span className="muted small">המזמינים לא רואים את הסבב עד שתפרסמו אותו.</span>
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
          <span className={'chip' + (round.archived || round.locked ? ' chip-warn' : '')}>
            {round.archived ? 'בארכיון' : round.locked ? 'נעול לשינויים' : 'פתוח להזמנות'}
          </span>
          <span className="muted small">
            {round.archived
              ? 'מוצג למזמינים בארכיון, לצפייה בלבד.'
              : round.locked
                ? 'המזמינים יכולים רק לצפות.'
                : 'המזמינים יכולים לערוך ולשלוח.'}
          </span>
          <div className="admin-actions admin-status-actions">
            {round.archived ? (
              <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setRound({ archived: false }, 'להחזיר את הסבב מהארכיון?')}>
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
                  <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setRound({ locked: false }, 'לפתוח את הסבב לשינויים?')}>
                    🔓 פתיחה מחדש
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => setRound({ locked: true }, 'לנעול את הסבב? המזמינים יוכלו רק לצפות בהזמנות.')}
                  >
                    🔒 נעילת הסבב
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => setRound({ archived: true }, 'להעביר את הסבב לארכיון? הוא יוצג למזמינים לצפייה בלבד.')}
                >
                  🗄 לארכיון
                </button>
              </>
            )}
            {deleteButton}
          </div>
        </div>
        <div className="admin-kpis">
          {kpi('all', 'מזמינים', count('all'))}
          {kpi('sent', 'שלחו', count('sent'))}
          {kpi('unsent', 'לא שלחו', count('unsent'), !round.locked && !round.archived)}
          {kpi('changed', 'שונו אחרי שליחה', count('changed'), true)}
          <button type="button" className="admin-kpi" aria-pressed={false} title={sentOnly} onClick={showProducts}>
            <span className="t">יחידות שנשלחו</span>
            <span className="v">{sum ? sum.units : '…'}</span>
            {sum && pendingNote && <span className="small admin-pending">לא כולל: {pendingNote}</span>}
          </button>
          <button type="button" className="admin-kpi" aria-pressed={false} title={sentOnly} onClick={showProducts}>
            <span className="t">{sum?.missingUnits ? 'לתשלום' : 'סכום'} (שנשלחו)</span>
            <span className="v">{sum ? toMoney(sum.amount) : '…'}</span>
            {sum && sum.unpricedUnits > 0 && <span className="small danger">+{sum.unpricedUnits} יח׳ ללא מחיר</span>}
          </button>
          {sum && sum.missingUnits > 0 && (
            <button type="button" className="admin-kpi warn" aria-pressed={false} onClick={showProducts}>
              <span className="t">לא הגיעו</span>
              <span className="v">{sum.missingUnits} יח׳</span>
              <span className="small muted">{toMoney(sum.missingAmount)} שלא יחויבו</span>
            </button>
          )}
        </div>
        {status.text && <div className={'status' + (status.error ? ' error' : '')}>{status.text}</div>}
      </section>

      {announcing && !round.locked && !round.archived ? (
        <AnnounceMail round={round} summaries={summaries} onClose={() => setAnnouncing(false)} onSignedOut={onSignedOut} />
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
              <>
                {filter !== 'all' && (
                  <div className="admin-filter-note">
                    <span className="chip">
                      מוצגים: {filter === 'sent' ? 'שלחו' : filter === 'unsent' ? 'לא שלחו' : 'שונו אחרי שליחה'} ({visibleOrderers.length})
                    </span>
                    <button type="button" className="btn-link" onClick={() => setFilter('all')}>
                      הצג את כולם
                    </button>
                  </div>
                )}
                <OrderersTable
                  rows={visibleOrderers}
                  totals={totals}
                  detail={data && { orders: data.orders, shortages: data.shortages, catalog: data.catalog, images: data.source.images }}
                />
              </>
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
