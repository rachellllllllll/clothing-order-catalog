import { Fragment, useState } from 'react';
import { ProductImage } from '../components/ProductImage';
import type { ProductRow, ProductsView } from '../lib/catalog/adminView';
import { toMoney } from '../lib/catalog/text';
import type { ImageRef } from '../lib/source/types';
import { ImageView } from './ImageView';

interface Props {
  view: ProductsView;
  images: Map<string, ImageRef>;
  /** Lower-cased search text: matches model, color or the name of someone who ordered the item. */
  query: string;
}

const lineLabel = (model: string, color: string) => [model, color].filter(Boolean).join(' · ');

function matches(row: ProductRow, query: string) {
  if (!query) return true;
  if (lineLabel(row.item.model, row.item.color).toLowerCase().includes(query)) return true;
  return Object.values(row.who).some((list) => list.some((w) => w.name.toLowerCase().includes(query)));
}

/** The round summed per catalog item and size; a row opens to show who ordered each size. */
export function ProductsTable({ view, images, query }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [showWho, setShowWho] = useState(false);
  const [open, setOpen] = useState<Map<string, string | null>>(new Map());
  const [enlarged, setEnlarged] = useState<{ src: string; caption: string } | null>(null);

  const rows = view.rows.filter((r) => (showAll || r.units > 0) && matches(r, query));
  const sizes = view.sizes;

  const sizeTotals: Record<string, number> = {};
  const sum = { units: 0, amount: 0, unpricedUnits: 0 };
  for (const r of rows) {
    for (const [size, qty] of Object.entries(r.qty)) sizeTotals[size] = (sizeTotals[size] ?? 0) + qty;
    sum.units += r.units;
    if (r.item.price == null) sum.unpricedUnits += r.units;
    else sum.amount += r.item.price * r.units;
  }

  /** Toggles a row; clicking a size cell opens the row with that size highlighted. */
  const toggle = (id: string, size: string | null = null) =>
    setOpen((cur) => {
      const next = new Map(cur);
      if (cur.has(id) && cur.get(id) === size) next.delete(id);
      else next.set(id, size);
      return next;
    });

  const colCount = sizes.length + 4;

  return (
    <div className="admin-products">
      <div className="admin-actions small">
        <label>
          <input type="checkbox" checked={showWho} onChange={(e) => setShowWho(e.target.checked)} /> הצג מי הזמין בכל השורות
        </label>
        <label>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> הצג גם פריטים שלא הוזמנו
        </label>
      </div>

      {!rows.length ? (
        <div className="muted">{query ? 'אין פריטים שמתאימים לחיפוש.' : 'עדיין לא הוזמנו פריטים בגרסה הזו.'}</div>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table admin-prod-table">
            <thead>
              <tr>
                <th className="admin-prod-item">פריט</th>
                <th className="num">מחיר</th>
                {sizes.map((s) => (
                  <th key={s} className="num admin-size">
                    {s}
                  </th>
                ))}
                <th className="num">סה״כ</th>
                <th className="num">סכום</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = showWho ? r.units > 0 : open.has(r.item.id);
                const focus = open.get(r.item.id) ?? null;
                const label = lineLabel(r.item.model, r.item.color);
                const image = images.get(r.item.modelKey);
                return (
                  <Fragment key={r.item.id}>
                    <tr className={isOpen ? 'open' : undefined}>
                      <td className="admin-prod-item">
                        <div className="admin-prod-cell">
                          {image ? (
                            <button
                              type="button"
                              className="admin-thumb-btn"
                              title="הגדלת התמונה"
                              onClick={() => setEnlarged({ src: image.full, caption: label })}
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
                          <button
                            type="button"
                            className="admin-prod-btn"
                            aria-expanded={isOpen}
                            disabled={!r.units || showWho}
                            onClick={() => toggle(r.item.id)}
                          >
                            <bdi>{label}</bdi>
                            {r.units > 0 && !showWho && <span className="admin-caret">{isOpen ? '▾' : '▸'}</span>}
                          </button>
                        </div>
                      </td>
                      <td className="num muted">{toMoney(r.item.price)}</td>
                      {sizes.map((s) => (
                        <td key={s} className={'num admin-size' + (isOpen && focus === s ? ' focus' : '')}>
                          {r.qty[s] ? (
                            <button
                              type="button"
                              className="admin-size-btn"
                              title={`מי הזמין ${label} במידה ${s}`}
                              onClick={() => toggle(r.item.id, s)}
                            >
                              {r.qty[s]}
                            </button>
                          ) : (
                            ''
                          )}
                        </td>
                      ))}
                      <td className="num strong">{r.units || ''}</td>
                      <td className="num">{r.units ? (r.item.price == null ? <span className="danger">ללא מחיר</span> : toMoney(r.item.price * r.units)) : ''}</td>
                    </tr>
                    {isOpen && (
                      <tr className="admin-who-row">
                        <td colSpan={colCount}>
                          <ul className="admin-who">
                            {sizes
                              .filter((s) => r.who[s])
                              .map((s) => (
                                <li key={s} className={focus === s ? 'focus' : undefined}>
                                  <b>
                                    מידה <bdi>{s}</bdi>
                                  </b>{' '}
                                  ({r.qty[s]} יח׳):{' '}
                                  {r.who[s].map((w, i) => (
                                    <Fragment key={w.name + i}>
                                      {i > 0 && ', '}
                                      <bdi>{w.name}</bdi>
                                      {w.qty > 1 && ` (${w.qty})`}
                                    </Fragment>
                                  ))}
                                </li>
                              ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="admin-prod-item">סה״כ ({rows.filter((r) => r.units).length} פריטים)</td>
                <td />
                {sizes.map((s) => (
                  <td key={s} className="num admin-size">
                    {sizeTotals[s] || ''}
                  </td>
                ))}
                <td className="num">{sum.units}</td>
                <td className="num">
                  {toMoney(sum.amount)}
                  {sum.unpricedUnits > 0 && <div className="danger small">+{sum.unpricedUnits} ללא מחיר</div>}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {view.missing.length > 0 && (
        <div className="notice notice-warn">
          <span>{view.missing.length} שורות שאינן בקטלוג הנוכחי (לא נספרו כאן ולא ייכללו באקסל המרוכז):</span>
          <ul className="notice-list">
            {view.missing.map((m, i) => (
              <li key={i}>
                <bdi>
                  {m.name}: {[m.line.model, m.line.color, 'מידה ' + m.line.size].filter(Boolean).join(' · ')} × {m.line.qty}
                </bdi>
              </li>
            ))}
          </ul>
        </div>
      )}

      {enlarged && <ImageView src={enlarged.src} caption={enlarged.caption} onClose={() => setEnlarged(null)} />}
    </div>
  );
}
