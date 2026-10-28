import { Fragment, useState } from 'react';
import type { OrderDto, OrderSummary } from '../../api/_types';
import { ProductImage } from '../components/ProductImage';
import { isChangedAfterSend, orderDetail, type Totals } from '../lib/catalog/adminView';
import type { CombineMode } from '../lib/catalog/combinedOrder';
import { formatSavedAt, toMoney } from '../lib/catalog/text';
import type { Catalog } from '../lib/catalog/types';
import type { ImageRef } from '../lib/source/types';
import { ImageView } from './ImageView';

/** What the order details are drawn from; null until the full orders and the catalog have loaded. */
export interface DetailSource {
  orders: Map<string, OrderDto>;
  catalog: Catalog;
  images: Map<string, ImageRef>;
}

interface Props {
  rows: OrderSummary[];
  /** Per-order totals of the chosen version; null until the full orders have loaded. */
  totals: Map<string, Totals> | null;
  detail: DetailSource | null;
  version: CombineMode;
  busy: boolean;
  onResetPin: (o: OrderSummary) => void;
}

type Enlarged = { src: string; caption: string };

export function OrderersTable({ rows, totals, detail, version, busy, onResetPin }: Props) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [enlarged, setEnlarged] = useState<Enlarged | null>(null);
  const of = (o: OrderSummary) => totals?.get(o.fileId);
  const notInVersion = (o: OrderSummary) => version === 'submitted' && !o.submittedAt;

  const toggle = (fileId: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(fileId)) next.add(fileId);
      return next;
    });

  const sum = { units: 0, amount: 0 };
  for (const o of rows) {
    sum.units += of(o)?.units ?? 0;
    sum.amount += of(o)?.amount ?? 0;
  }

  if (!rows.length) return <div className="muted">אין מזמינים שמתאימים לסינון.</div>;

  return (
    <div className="admin-products">
      <div className="admin-actions small">
        <label>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> הצג פירוט לכל המזמינים
        </label>
      </div>
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>שם</th>
            <th className="num">יחידות</th>
            <th className="num">סכום</th>
            <th className="admin-col-updated">עודכן</th>
            <th>נשלח</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => {
            const t = of(o);
            const order = detail?.orders.get(o.fileId);
            const isOpen = showAll || open.has(o.fileId);
            return (
              <Fragment key={o.fileId}>
              <tr className={isOpen ? 'open' : undefined}>
                <td>
                  <button
                    type="button"
                    className="admin-prod-btn admin-name-btn"
                    aria-expanded={isOpen}
                    disabled={showAll}
                    onClick={() => toggle(o.fileId)}
                  >
                    <span className="admin-caret">{isOpen ? '▾' : '▸'}</span>
                    <bdi>{o.name}</bdi>
                    {!o.hasPin && <span className="chip chip-warn admin-chip">קוד אופס</span>}
                  </button>
                </td>
                <td className="num">{notInVersion(o) ? '—' : t ? t.units : version === 'current' ? o.units : '…'}</td>
                <td className="num">
                  {notInVersion(o) ? (
                    '—'
                  ) : t ? (
                    <>
                      {toMoney(t.amount)}
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
                <td className="admin-col-updated">{formatSavedAt(o.updatedAt)}</td>
                <td>
                  {o.submittedAt ? (
                    <>
                      <span className="save-ok">✓ {formatSavedAt(o.submittedAt)}</span>
                      {isChangedAfterSend(o) && <div className="danger small">שונתה אחרי השליחה</div>}
                    </>
                  ) : (
                    <span className="muted">לא נשלחה</span>
                  )}
                </td>
                <td>
                  <div className="admin-row-actions">
                    <button type="button" className="btn-secondary btn-sm" disabled={busy || !o.hasPin} onClick={() => onResetPin(o)}>
                      איפוס קוד
                    </button>
                  </div>
                </td>
              </tr>
              {isOpen && (
                <tr className="admin-who-row">
                  <td colSpan={6}>
                    {detail && order ? (
                      <OrderDetail order={order} source={detail} version={version} onEnlarge={setEnlarged} />
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
              <td className="num">{sum.units}</td>
              <td className="num">{toMoney(sum.amount)}</td>
              <td className="admin-col-updated" />
              <td colSpan={2} />
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
  order: OrderDto;
  source: DetailSource;
  version: CombineMode;
  onEnlarge: (e: Enlarged) => void;
}

/** One order's lines; after a change since sending, the sent and current quantities side by side. */
function OrderDetail({ order, source, version, onEnlarge }: DetailProps) {
  const rows = orderDetail(source.catalog, order);
  const changed = !!order.submitted && order.submitted.rev !== order.rev;
  // The amount follows the chosen version when both are shown; otherwise there is only one quantity.
  const qtyOf = (r: (typeof rows)[number]) => (changed && version === 'submitted' ? r.sent : r.current);

  const sum = { sent: 0, current: 0, amount: 0 };
  for (const r of rows) {
    sum.sent += r.sent;
    sum.current += r.current;
    if (r.item?.price != null) sum.amount += r.item.price * qtyOf(r);
  }

  const note = !order.submitted
    ? 'טיוטה — עדיין לא נשלחה.'
    : changed
      ? `שונתה אחרי השליחה (נשלחה ${formatSavedAt(order.submitted.at)}). שורות שהשתנו מסומנות.`
      : `נשלחה ${formatSavedAt(order.submitted.at)}.`;

  return (
    <div className="admin-detail">
      <div className={'small' + (changed ? ' danger' : ' muted')}>{note}</div>
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
              <th className="num">מחיר</th>
              <th className="num">סכום</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const label = [r.model, r.color].filter(Boolean).join(' · ');
              const image = r.item && source.images.get(r.item.modelKey);
              const qty = qtyOf(r);
              return (
                <tr key={r.id + '|' + r.size} className={changed && r.sent !== r.current ? 'diff' : undefined}>
                  <td>
                    <div className="admin-prod-cell">
                      {image ? (
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
                      <bdi>{label}</bdi>
                      {!r.item && <span className="chip chip-warn admin-chip">לא בקטלוג</span>}
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
                  <td className="num muted">{r.item ? toMoney(r.item.price) : ''}</td>
                  <td className="num">{r.item?.price != null && qty ? toMoney(r.item.price * qty) : ''}</td>
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
              <td />
              <td className="num">{toMoney(sum.amount)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}
