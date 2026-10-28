import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OrderDto, OrderSummary, RoundState } from '../../api/_types';
import { ApiError, apiPost } from '../lib/api/client';
import { linesTotals, matchesStatus, productsView, versionLines, type StatusFilter, type Totals } from '../lib/catalog/adminView';
import { buildCombinedWorkbook, combinedFileName, combineOrders, type CombineMode } from '../lib/catalog/combinedOrder';
import { downloadBlob } from '../lib/catalog/exportOrder';
import { parseCatalog } from '../lib/catalog/parseCatalog';
import { formatSavedAt, toMoney } from '../lib/catalog/text';
import type { Catalog } from '../lib/catalog/types';
import { loadDriveCatalog } from '../lib/source/drive';
import type { CatalogSource, Round } from '../lib/source/types';
import { readFirstSheet } from '../lib/xlsx/xlsx';
import { OrderersTable } from './OrderersTable';
import { ProductsTable } from './ProductsTable';

export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Tab = 'orderers' | 'products';

/** Everything the views are computed from: all orders with their lines, and the round's catalog. */
interface RoundData {
  orders: Map<string, OrderDto>;
  catalog: Catalog;
  source: CatalogSource;
  loadedAt: string;
}

interface RoundAdminProps {
  round: Round;
  onRoundState: (id: string, state: RoundState) => void;
  onSignedOut: () => void;
}

export function RoundAdmin({ round, onRoundState, onSignedOut }: RoundAdminProps) {
  const [summaries, setSummaries] = useState<OrderSummary[] | null>(null);
  const [data, setData] = useState<RoundData | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: '' });
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState<CombineMode>('submitted');
  const [tab, setTab] = useState<Tab>('orderers');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');

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
      apiPost<{ orders: { fileId: string; order: OrderDto }[] }>('/api/admin', { action: 'allOrders', round: round.id }),
      loadDriveCatalog(round).then(async (source) => ({ source, catalog: parseCatalog(await readFirstSheet(source.excelData)) })),
    ]);
    full.catch(() => undefined);
    try {
      const res = await apiPost<{ round: RoundState; orders: OrderSummary[] }>('/api/admin', { action: 'orders', round: round.id });
      setSummaries(res.orders);
      onRoundState(round.id, res.round);
      const [{ orders }, cat] = await full;
      setData({ orders: new Map(orders.map((o) => [o.fileId, o.order])), ...cat, loadedAt: new Date().toISOString() });
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
  }, [round.id, onRoundState, fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      onRoundState(round.id, res.round);
    });

  const resetPin = (o: OrderSummary) =>
    window.confirm(`לאפס את הקוד של ${o.name}? בכניסה הבאה הקוד שיוקלד ייקבע כקוד החדש, וכל המכשירים שמחוברים כעת ינותקו.`) &&
    run(async () => {
      await apiPost('/api/admin', { action: 'resetPin', round: round.id, fileId: o.fileId });
      setStatus({ text: `הקוד של ${o.name} אופס.` });
      await refresh();
    });

  const downloadExcel = () =>
    data &&
    run(async () => {
      const combined = combineOrders(data.catalog, [...data.orders.values()], version);
      downloadBlob(await buildCombinedWorkbook(data.source.excelData, combined), combinedFileName(data.source.excelName));
      const parts = [`ירד אקסל מרוכז: ${combined.units} יחידות מ־${combined.included.length} מזמינים.`];
      if (combined.skipped.length) parts.push(`לא נכללו (${version === 'submitted' ? 'לא שלחו / ריקה' : 'ריקה'}): ${combined.skipped.join(', ')}.`);
      if (combined.missing.length) parts.push(`${combined.missing.length} שורות שאינן בקטלוג לא נכללו — מפורטות בתצוגה "לפי מוצרים".`);
      setStatus({ text: parts.join(' ') });
    });

  const totals = useMemo(() => {
    if (!data) return null;
    const map = new Map<string, Totals>();
    for (const [fileId, order] of data.orders) map.set(fileId, linesTotals(data.catalog, versionLines(order, version)));
    return map;
  }, [data, version]);

  const products = useMemo(
    () => (data ? productsView(data.catalog, [...data.orders.values()], version) : null),
    [data, version],
  );

  const count = (f: StatusFilter) => summaries?.filter((o) => matchesStatus(o, f)).length ?? 0;
  let sum: Totals | null = null;
  if (totals) {
    sum = { units: 0, amount: 0, unpricedUnits: 0 };
    for (const t of totals.values()) {
      sum.units += t.units;
      sum.amount += t.amount;
      sum.unpricedUnits += t.unpricedUnits;
    }
  }

  const query = search.trim().toLowerCase();
  const visibleOrderers =
    summaries?.filter((o) => matchesStatus(o, filter) && (!query || o.name.toLowerCase().includes(query))) ?? null;

  const pickFilter = (f: StatusFilter) => {
    setTab('orderers');
    setFilter((cur) => (cur === f && f !== 'all' ? 'all' : f));
  };

  const kpi = (f: StatusFilter, label: string, value: number, warn = false) => (
    <button
      type="button"
      className={'admin-kpi' + (warn && value ? ' warn' : '')}
      aria-pressed={tab === 'orderers' && filter === f}
      onClick={() => pickFilter(f)}
    >
      <span className="t">{label}</span>
      <span className="v">{summaries ? value : '…'}</span>
    </button>
  );

  const versionNote = version === 'submitted' ? 'שנשלחו' : 'נוכחי';

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
                ? 'המזמינים יכולים רק לצפות. השלב הבא: הורדת אקסל מרוכז.'
                : 'המזמינים יכולים לערוך ולשלוח.'}
          </span>
          <div className="admin-actions admin-status-actions">
            {round.archived ? (
              <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setRound({ archived: false }, 'להחזיר את הסבב מהארכיון?')}>
                החזרה מהארכיון
              </button>
            ) : (
              <>
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
          </div>
        </div>
        <div className="admin-kpis">
          {kpi('all', 'מזמינים', count('all'))}
          {kpi('sent', 'שלחו', count('sent'))}
          {kpi('unsent', 'לא שלחו', count('unsent'), !round.locked && !round.archived)}
          {kpi('changed', 'שונו אחרי שליחה', count('changed'), true)}
          <button type="button" className="admin-kpi" aria-pressed={false} onClick={() => setTab('products')}>
            <span className="t">יחידות ({versionNote})</span>
            <span className="v">{sum ? sum.units : '…'}</span>
          </button>
          <button type="button" className="admin-kpi" aria-pressed={false} onClick={() => setTab('products')}>
            <span className="t">סכום ({versionNote})</span>
            <span className="v">{sum ? toMoney(sum.amount) : '…'}</span>
            {sum && sum.unpricedUnits > 0 && <span className="small danger">+{sum.unpricedUnits} יח׳ ללא מחיר</span>}
          </button>
        </div>
        {status.text && <div className={'status' + (status.error ? ' error' : '')}>{status.text}</div>}
      </section>

      <section className="panel admin-main">
        <div className="admin-toolbar">
          <div className="admin-seg" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'orderers'} onClick={() => setTab('orderers')}>
              לפי מזמינים
            </button>
            <button type="button" role="tab" aria-selected={tab === 'products'} onClick={() => setTab('products')}>
              לפי מוצרים
            </button>
          </div>
          <div className="admin-seg" role="group" aria-label="גרסת ההזמנות">
            <button
              type="button"
              aria-pressed={version === 'submitted'}
              title="הגרסה האחרונה שכל מזמין שלח (מי שלא שלח — לא נספר)"
              onClick={() => setVersion('submitted')}
            >
              שנשלחו
            </button>
            <button
              type="button"
              aria-pressed={version === 'current'}
              title="מצב ההזמנות כרגע, כולל שינויים והזמנות שלא נשלחו"
              onClick={() => setVersion('current')}
            >
              מצב נוכחי
            </button>
          </div>
          <input
            type="search"
            className="admin-search"
            placeholder={tab === 'orderers' ? 'חיפוש מזמין…' : 'חיפוש דגם, צבע או מזמין…'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="admin-toolbar-end">
            <button
              type="button"
              className={(round.locked ? 'btn-primary' : 'btn-secondary') + ' btn-sm'}
              disabled={busy || !data}
              title={`אקסל הספק עם סיכום ההזמנות (${versionNote})`}
              onClick={() => void downloadExcel()}
            >
              ⬇ אקסל מרוכז
            </button>
            <button type="button" className="btn-secondary btn-sm" disabled={loading} onClick={() => void refresh()} title="טעינה מחדש של ההזמנות והקטלוג">
              ↻ {loading ? 'טוען…' : 'רענון'}
            </button>
            {data && <span className="muted small">נטען {formatSavedAt(data.loadedAt)}</span>}
          </div>
        </div>

        {tab === 'orderers' ? (
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
                detail={data && { orders: data.orders, catalog: data.catalog, images: data.source.images }}
                version={version}
                busy={busy}
                onResetPin={(o) => void resetPin(o)}
              />
            </>
          )
        ) : !data || !products ? (
          <div className="muted">טוען הזמנות וקטלוג…</div>
        ) : (
          <ProductsTable view={products} images={data.source.images} query={query} />
        )}
      </section>
    </>
  );
}
