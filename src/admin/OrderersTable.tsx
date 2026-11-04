import { Fragment, useState } from 'react';
import type { OrderDto, OrderSummary, Shortages } from '../../api/_types';
import { ProductImage } from '../components/ProductImage';
import { isChangedAfterSend, orderDetail, unsentNote, unsentUnits, type Totals } from '../lib/catalog/adminView';
import { missingQty, shortageIndex } from '../lib/catalog/shortages';
import { formatSavedAt, notArrived, toMoney } from '../lib/catalog/text';
import type { Catalog } from '../lib/catalog/types';
import type { ImageRef } from '../lib/source/types';
import { ImageView } from './ImageView';

/** What the order details are drawn from; null until the full orders and the catalog have loaded. */
export interface DetailSource {
  orders: Map<string, OrderDto>;
  shortages: Shortages;
  catalog: Catalog;
  images: Map<string, ImageRef>;
}

interface Props {
  rows: OrderSummary[];
  /** Per-order totals of the sent version; null until the full orders have loaded. */
  totals: Map<string, Totals> | null;
  detail: DetailSource | null;
  /** The round is locked or archived: the sent versions are final, so unsent units are not summed up. */
  final: boolean;
}

type Enlarged = { src: string; caption: string };

type SortKey = 'name' | 'units' | 'amount' | 'sent';
/** A column's first click: names A→Z, numbers largest first, status by what needs attention first. */
const FIRST_DESC: Record<SortKey, boolean> = { name: false, units: true, amount: true, sent: false };

/** A draft that has no items: nothing to act on, so it always sits at the end of the list. */
const isEmpty = (o: OrderSummary) => !o.submittedAt && !o.units;
/** Changed after sending, then drafts, then sent. */
const statusRank = (o: OrderSummary) => (isChangedAfterSend(o) ? 0 : !o.submittedAt ? 1 : 2);

/** The caret in a table's first header cell: opens or closes every row's detail at once. */
export function ExpandAll({ allOpen, onClick }: { allOpen: boolean; onClick: () => void }) {
  const label = allOpen ? 'סגירת כל הפירוטים' : 'פתיחת כל הפירוטים';
  return (
    <button type="button" className="admin-expand-all" aria-expanded={allOpen} aria-label={label} title={label} onClick={onClick}>
      {allOpen ? '▾' : '▸'}
    </button>
  );
}

export function OrderersTable({ rows, totals, detail, final }: Props) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });
  const [enlarged, setEnlarged] = useState<Enlarged | null>(null);
  const of = (o: OrderSummary) => totals?.get(o.fileId);

  /** The value a column sorts by; null (no value, e.g. the amount of a draft) always goes last. */
  const sortValue = (o: OrderSummary): number | null => {
    switch (sort.key) {
      case 'units':
        return o.submittedAt ? (of(o)?.units ?? null) : o.units;
      case 'amount':
        return o.submittedAt ? (of(o)?.amount ?? null) : null;
      default:
        return null;
    }
  };
  const compare = (a: OrderSummary, b: OrderSummary): number => {
    if (sort.key === 'name') return a.name.localeCompare(b.name, 'he');
    if (sort.key === 'sent') {
      // Within a status, the latest activity first.
      const at = (o: OrderSummary) => (isChangedAfterSend(o) || !o.submittedAt ? o.updatedAt : o.submittedAt!);
      return statusRank(a) - statusRank(b) || at(b).localeCompare(at(a));
    }
    return (sortValue(a) ?? 0) - (sortValue(b) ?? 0);
  };
  const sorted = [...rows].sort((a, b) => {
    const empty = Number(isEmpty(a)) - Number(isEmpty(b));
    if (empty) return empty;
    const missing = Number(sortValue(a) === null) - Number(sortValue(b) === null);
    if (missing) return missing;
    return (sort.desc ? -compare(a, b) : compare(a, b)) || a.name.localeCompare(b.name, 'he');
  });

  const sortButton = (key: SortKey, label: string) => (
    <button
      type="button"
      className="admin-sort"
      onClick={() => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: FIRST_DESC[key] }))}
    >
      {label}
      <span className="admin-sort-arrow">{sort.key === key ? (sort.desc ? '▼' : '▲') : ''}</span>
    </button>
  );
  const sortHeader = (key: SortKey, label: string, className?: string) => (
    <th className={className} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      {sortButton(key, label)}
    </th>
  );

  const toggle = (fileId: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(fileId)) next.add(fileId);
      return next;
    });

  // Opens or closes every listed row; each row can still be toggled on its own afterwards.
  const allOpen = rows.every((o) => open.has(o.fileId));
  const toggleAll = () =>
    setOpen((cur) => {
      const next = new Set(cur);
      for (const o of rows) {
        if (allOpen) next.delete(o.fileId);
        else next.add(o.fileId);
      }
      return next;
    });

  const sum = { units: 0, amount: 0, missingUnits: 0 };
  for (const o of rows) {
    sum.units += of(o)?.units ?? 0;
    sum.amount += of(o)?.amount ?? 0;
    sum.missingUnits += of(o)?.missingUnits ?? 0;
  }
  const pending = final ? '' : unsentNote(unsentUnits(rows, (o) => of(o)?.units));

  if (!rows.length) return <div className="muted">אין מזמינים שמתאימים לסינון.</div>;

  return (
    <div className="admin-products">
    <div className="admin-table-wrap">
      <table className="admin-table admin-orderers-table">
        <thead>
          <tr>
            <th aria-sort={sort.key === 'name' ? (sort.desc ? 'descending' : 'ascending') : undefined}>
              <ExpandAll allOpen={allOpen} onClick={toggleAll} />
              {sortButton('name', 'שם')}
            </th>
            {sortHeader('sent', 'נשלח')}
            {sortHeader('units', 'יחידות', 'num')}
            {sortHeader('amount', sum.missingUnits ? 'לתשלום' : 'סכום', 'num')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((o) => {
            const t = of(o);
            const order = detail?.orders.get(o.fileId);
            const isOpen = open.has(o.fileId);
            return (
              <Fragment key={o.fileId}>
              <tr className={[isOpen && 'open', isEmpty(o) && 'admin-empty-row'].filter(Boolean).join(' ') || undefined}>
                <td>
                  <button
                    type="button"
                    className="admin-prod-btn admin-name-btn"
                    aria-expanded={isOpen}
                    onClick={() => toggle(o.fileId)}
                  >
                    <span className="admin-caret">{isOpen ? '▾' : '▸'}</span>
                    <bdi>{o.name}</bdi>
                  </button>
                </td>
                <td>
                  {o.submittedAt ? (
                    <>
                      <span className="save-ok">✓ {formatSavedAt(o.submittedAt)}</span>
                      {isChangedAfterSend(o) && (
                        <div className="danger small">שונתה אחרי השליחה {formatSavedAt(o.updatedAt)}</div>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="muted">לא נשלחה</span>
                      <div className="muted small">עודכנה {formatSavedAt(o.updatedAt)}</div>
                    </>
                  )}
                </td>
                <td className="num">
                  {!o.submittedAt ? (
                    <span className="admin-pending" title="טיוטה שלא נשלחה — לא נכללת בסיכומים">
                      {o.units ? `${o.units} בטיוטה` : 'ריקה'}
                    </span>
                  ) : t ? (
                    <>
                      {t.units}
                      {isChangedAfterSend(o) && o.units !== t.units && (
                        <div className="danger small" title="הכמות בהזמנה כרגע, אחרי שינויים שלא נשלחו">
                          עכשיו {o.units}
                        </div>
                      )}
                    </>
                  ) : (
                    '…'
                  )}
                </td>
                <td className="num">
                  {!o.submittedAt ? (
                    '—'
                  ) : t ? (
                    <>
                      {toMoney(t.amount)}
                      {t.missingUnits > 0 && (
                        <div className="danger small" title={`לא מחויבים: ${toMoney(t.missingAmount)}`}>
                          {notArrived(t.missingUnits)}
                        </div>
                      )}
                      {t.unpricedUnits > 0 && (
                        <div className="danger small" title="יחידות שאין להן מחיר בקטלוג">
                          +{t.unpricedUnits} ללא מחיר
                        </div>
                      )}
                    </>
                  ) : (
                    '…'
                  )}
                </td>
              </tr>
              {isOpen && (
                <tr className="admin-who-row">
                  <td colSpan={4}>
                    {detail && order ? (
                      <OrderDetail
                        name={o.name}
                        order={order}
                        shortages={detail.shortages[o.fileId]}
                        source={detail}
                        onEnlarge={setEnlarged}
                      />
                    ) : (
                      <div className="muted">טוען…</div>
                    )}
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
        {totals && (
          <tfoot>
            <tr>
              <td>סה״כ ({rows.length})</td>
              <td />
              <td className="num">
                {sum.units}
                {pending && <div className="admin-pending small">{pending}</div>}
              </td>
              <td className="num">
                {toMoney(sum.amount)}
                {sum.missingUnits > 0 && <div className="danger small">{notArrived(sum.missingUnits)}</div>}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
      {enlarged && <ImageView src={enlarged.src} caption={enlarged.caption} onClose={() => setEnlarged(null)} />}
    </div>
  );
}

interface DetailProps {
  name: string;
  order: OrderDto;
  shortages: Shortages[string] | undefined;
  source: DetailSource;
  onEnlarge: (e: Enlarged) => void;
}

/** One order's lines; after a change since sending, the sent and current quantities side by side. */
function OrderDetail({ name, order, shortages, source, onEnlarge }: DetailProps) {
  const rows = orderDetail(source.catalog, order);
  const changed = !!order.submitted && order.submitted.rev !== order.rev;
  // Amounts follow the sent version (what is charged); a draft that was never sent shows its own lines.
  const qtyOf = (r: (typeof rows)[number]) => (order.submitted ? r.sent : r.current);
  const index = shortageIndex(shortages);
  const missingOf = (r: (typeof rows)[number]) => missingQty(index, r.id, r.size, qtyOf(r));
  const anyMissing = rows.some((r) => missingOf(r) > 0);

  const sum = { sent: 0, current: 0, amount: 0, missing: 0 };
  for (const r of rows) {
    sum.sent += r.sent;
    sum.current += r.current;
    sum.missing += missingOf(r);
    if (r.item?.price != null) sum.amount += r.item.price * (qtyOf(r) - missingOf(r));
  }

  // The orderer's row already shows when it was sent and changed; only what the row doesn't say.
  const note = !order.submitted
    ? 'טיוטה — לא נכללת בסיכומים.'
    : changed
      ? 'הסכום לפי מה שנשלח; שורות שהשתנו מסומנות.'
      : '';

  return (
    <div className="admin-detail">
      {/* Stays under the table header while the detail scrolls by; the name shows once the orderer's row is gone. */}
      <div className="admin-detail-head">
        <div className="admin-detail-bar">
          <bdi className="admin-detail-who">{name}</bdi>
          {note && <span className={'admin-detail-note small' + (changed ? ' danger' : ' muted')}>{note}</span>}
        </div>
      </div>
      {!rows.length ? (
        <div className="muted">ההזמנה ריקה.</div>
      ) : (
        <table className="admin-table admin-sub-table">
          <thead>
            <tr>
              <th>פריט</th>
              <th>מידה</th>
              {changed ? (
                <>
                  <th className="num">נשלח</th>
                  <th className="num">נוכחי</th>
                </>
              ) : (
                <th className="num">כמות</th>
              )}
              {anyMissing && <th className="num">לא הגיע</th>}
              <th className="num">מחיר</th>
              <th className="num">{anyMissing ? 'לתשלום' : 'סכום'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const label = [r.model, r.color].filter(Boolean).join(' · ');
              const image = r.item && source.images.get(r.item.modelKey);
              const qty = qtyOf(r);
              const missing = missingOf(r);
              // Like the products table: the model's name and picture once, then only the color, or nothing for another size.
              const modelOf = (x: (typeof rows)[number] | undefined) => x && (x.item?.modelKey ?? x.model);
              const prev = rows[i - 1];
              const sameItemAsPrev = prev?.id === r.id;
              const sameModelAsPrev = modelOf(prev) === modelOf(r) && !!r.color;
              const sameModelAsNext = modelOf(rows[i + 1]) === modelOf(r);
              const cls = [changed && r.sent !== r.current && 'diff', missing && 'short', sameModelAsNext && 'admin-model-more']
                .filter(Boolean)
                .join(' ');
              return (
                <tr key={r.id + '|' + r.size} className={cls || undefined}>
                  <td>
                    <div className="admin-prod-cell">
                      {sameItemAsPrev || sameModelAsPrev ? (
                        <span className="admin-thumb admin-thumb-none" />
                      ) : image ? (
                        <button
                          type="button"
                          className="admin-thumb-btn"
                          title="הגדלת התמונה"
                          onClick={() => onEnlarge({ src: image.full, caption: label })}
                        >
                          <ProductImage
                            src={image.thumb}
                            alt={label}
                            placeholder=""
                            placeholderClassName="admin-thumb admin-thumb-empty"
                            className="admin-thumb"
                          />
                        </button>
                      ) : (
                        <span className="admin-thumb admin-thumb-empty" />
                      )}
                      {!sameItemAsPrev && <bdi>{sameModelAsPrev ? r.color : label}</bdi>}
                      {!r.item && !sameItemAsPrev && <span className="chip chip-warn admin-chip">לא בקטלוג</span>}
                    </div>
                  </td>
                  <td>
                    <bdi>{r.size}</bdi>
                  </td>
                  {changed ? (
                    <>
                      <td className="num">{r.sent || '—'}</td>
                      <td className="num">{r.current || '—'}</td>
                    </>
                  ) : (
                    <td className="num">{r.current}</td>
                  )}
                  {anyMissing && <td className="num danger">{missing || ''}</td>}
                  <td className="num muted">{r.item ? toMoney(r.item.price) : ''}</td>
                  <td className="num">{r.item?.price != null && qty ? toMoney(r.item.price * (qty - missing)) : ''}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>סה״כ</td>
              {changed ? (
                <>
                  <td className="num">{sum.sent}</td>
                  <td className="num">{sum.current}</td>
                </>
              ) : (
                <td className="num">{sum.current}</td>
              )}
              {anyMissing && <td className="num danger">{sum.missing}</td>}
              <td />
              <td className="num">{toMoney(sum.amount)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}
