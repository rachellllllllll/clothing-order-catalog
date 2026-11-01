import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ShortageChange } from '../../api/_types';
import { ProductImage } from '../components/ProductImage';
import type { ProductRow, ProductsView, WhoOrdered } from '../lib/catalog/adminView';
import { notArrived, signed, toMoney } from '../lib/catalog/text';
import type { ImageRef } from '../lib/source/types';
import { ImageView } from './ImageView';

interface Props {
  view: ProductsView;
  images: Map<string, ImageRef>;
  /** Lower-cased search text: matches model, color or the name of someone who ordered the item. */
  query: string;
  /** Units that did not arrive can be marked (closed rounds only). */
  canMark: boolean;
  /** "Receiving goods" mode: size cells become arrived/ordered steppers. */
  receiving: boolean;
  onReceivingChange: (on: boolean) => void;
  busy: boolean;
  onMark: (changes: ShortageChange[]) => void;
}

const lineLabel = (model: string, color: string) => [model, color].filter(Boolean).join(' · ');

const PENDING_TITLE = 'טיוטות ושינויים שעדיין לא נשלחו — לא נכללים בכמויות ובסכום';

/** Marks (or clears) every orderer of the row's sizes — all sizes, or only `size`. */
function rowChanges(r: ProductRow, missing: boolean, size?: string): ShortageChange[] {
  return Object.entries(r.who)
    .filter(([s]) => size === undefined || s === size)
    .flatMap(([s, list]) => list.map((w) => ({ fileId: w.fileId, id: r.item.id, size: s, qty: missing ? w.qty : 0 })));
}

/** One more unit of a size did not arrive ('miss'), or one marked unit arrived after all ('back'). */
type Step = 'miss' | 'back';

const stepCandidates = (list: readonly WhoOrdered[], dir: Step) =>
  list.filter((w) => (dir === 'miss' ? w.missing < w.qty : w.missing > 0));

const stepChange = (r: ProductRow, size: string, w: WhoOrdered, dir: Step): ShortageChange => ({
  fileId: w.fileId,
  id: r.item.id,
  size,
  qty: w.missing + (dir === 'miss' ? 1 : -1),
});

function matches(row: ProductRow, query: string) {
  if (!query) return true;
  if (lineLabel(row.item.model, row.item.color).toLowerCase().includes(query)) return true;
  return Object.values(row.who).some((list) => list.some((w) => w.name.toLowerCase().includes(query)));
}

/** The round summed per catalog item and size; a row opens to show who ordered each size. */
export function ProductsTable({ view, images, query, canMark, receiving, onReceivingChange, busy, onMark }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Map<string, string | null>>(new Map());
  const [enlarged, setEnlarged] = useState<{ src: string; caption: string } | null>(null);
  const [pick, setPick] = useState<{ id: string; size: string; dir: Step } | null>(null);
  const editing = canMark && receiving;

  // Items ordered only in drafts or unsent changes are listed too (outside receiving, which is about sent goods).
  const ordered = (r: ProductRow) => r.units > 0 || (!editing && r.pending > 0);
  const rows = view.rows.filter((r) => (showAll || ordered(r)) && matches(r, query));
  const unordered = view.rows.filter((r) => !ordered(r) && matches(r, query)).length;
  const sizes = view.sizes;

  const sizeTotals: Record<string, number> = {};
  const sum = { units: 0, amount: 0, orderedAmount: 0, unpricedUnits: 0, missingUnits: 0, pending: 0 };
  for (const r of rows) {
    for (const [size, qty] of Object.entries(r.qty)) sizeTotals[size] = (sizeTotals[size] ?? 0) + qty;
    sum.units += r.units;
    sum.missingUnits += r.missingUnits;
    sum.pending += r.pending;
    if (r.item.price == null) sum.unpricedUnits += r.units - r.missingUnits;
    else {
      sum.amount += r.item.price * (r.units - r.missingUnits);
      sum.orderedAmount += r.item.price * r.units;
    }
  }

  /** The caret opens or closes a row; a size cell opens it with that size highlighted, and closes it on a second click. */
  const toggle = (id: string, size: string | null = null) =>
    setOpen((cur) => {
      const next = new Map(cur);
      if (cur.has(id) && (size === null || cur.get(id) === size)) next.delete(id);
      else next.set(id, size);
      return next;
    });

  // Opens or closes every listed row that has sent units; each row can still be toggled on its own afterwards.
  const openable = rows.filter((r) => r.units > 0);
  const allOpen = openable.length > 0 && openable.every((r) => open.has(r.item.id));
  const toggleAll = () =>
    setOpen((cur) => {
      const next = new Map(cur);
      for (const r of openable) {
        if (allOpen) next.delete(r.item.id);
        else if (!next.has(r.item.id)) next.set(r.item.id, null);
      }
      return next;
    });

  /** A single orderer to charge the step to is picked automatically; otherwise ask who. */
  function step(r: ProductRow, size: string, dir: Step) {
    const candidates = stepCandidates(r.who[size] ?? [], dir);
    if (candidates.length === 1) {
      setPick(null);
      onMark([stepChange(r, size, candidates[0], dir)]);
    } else if (candidates.length > 1) {
      setPick({ id: r.item.id, size, dir });
    }
  }

  return (
    <div className={'admin-products' + (editing ? ' receiving' : '')}>
      <div className="admin-actions small">
        {openable.length > 0 && (
          <button type="button" className="btn-link" onClick={toggleAll}>
            {allOpen ? '▴ סגירת כל הפירוטים' : '▾ פתיחת כל הפירוטים'}
          </button>
        )}
        {unordered > 0 && (
          <button type="button" className="btn-link" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
            {showAll ? `הסתרת ${unordered} פריטים שלא הוזמנו` : `הצג גם ${unordered} פריטים שלא הוזמנו`}
          </button>
        )}
        <span className="admin-actions-end">
          <button
            type="button"
            className={editing ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
            aria-pressed={editing}
            disabled={!canMark}
            title="סימון מה שלא הגיע מהספק — המזמינים לא יחויבו עליו"
            onClick={() => {
              onReceivingChange(!editing);
              setPick(null);
            }}
          >
            {editing ? '✓ סיום קבלת סחורה' : '📦 קבלת סחורה'}
          </button>
          {!canMark && <span className="muted">אחרי נעילת הסבב</span>}
        </span>
      </div>
      {editing && (
        <div className="notice admin-recv-hint" role="status">
          מוצגות הכמויות שנשלחו לספק (הגיעו/הוזמנו) · <b>−</b> יחידה שלא הגיעה · <b>+</b> הגיעה בסוף · המזמינים
          לא יחויבו על מה שלא הגיע
        </div>
      )}

      {!rows.length ? (
        <div className="muted">{query ? 'אין פריטים שמתאימים לחיפוש.' : 'עדיין לא הוזמנו פריטים.'}</div>
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
                <th className="num">סה״כ נשלח</th>
                <th className="num">{sum.missingUnits ? 'לתשלום' : 'סכום'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const isOpen = r.units > 0 && open.has(r.item.id);
                const focus = open.get(r.item.id) ?? null;
                const label = lineLabel(r.item.model, r.item.color);
                // Colors of one model in a row: the model's name and picture only on the first, a faint line between them.
                const isColorOf = (m: ProductRow | undefined) => !!m && m.item.modelKey === r.item.modelKey && !!m.item.color;
                const sameAsPrev = !!r.item.color && isColorOf(rows[i - 1]);
                const sameAsNext = isColorOf(rows[i + 1]);
                const image = images.get(r.item.modelKey);
                const allMissing = r.units > 0 && r.missingUnits === r.units;
                const modelRows = view.rows.filter((m) => m.item.modelKey === r.item.modelKey && m.units > 0);
                const modelMissing = modelRows.every((m) => m.missingUnits === m.units);
                const firstOfModel = rows.find((m) => m.item.modelKey === r.item.modelKey && m.units > 0) === r;
                return (
                  <Fragment key={r.item.id}>
                    <tr
                      className={
                        [isOpen && 'open', r.missingUnits > 0 && 'has-short', sameAsNext && !isOpen && 'admin-model-more']
                          .filter(Boolean)
                          .join(' ') || undefined
                      }
                    >
                      <td className="admin-prod-item">
                        <div className="admin-prod-cell">
                          {sameAsPrev ? (
                            <span className="admin-thumb admin-thumb-none" />
                          ) : image ? (
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
                          <div className="admin-prod-main">
                            <button
                              type="button"
                              className="admin-prod-btn"
                              aria-expanded={isOpen}
                              disabled={!r.units}
                              onClick={() => toggle(r.item.id)}
                            >
                              <span className={'admin-caret' + (r.units > 0 ? '' : ' admin-caret-none')}>
                                {isOpen ? '▾' : '▸'}
                              </span>
                              <bdi>{sameAsPrev ? r.item.color : label}</bdi>
                              {r.missingUnits > 0 && (
                                <span className="chip chip-warn admin-chip">
                                  {allMissing ? 'לא הגיע' : notArrived(r.missingUnits)}
                                </span>
                              )}
                            </button>
                            {editing && r.units > 0 && (
                              <div className="admin-recv-row">
                                {allMissing ? (
                                  <button type="button" className="btn-link" disabled={busy} onClick={() => onMark(rowChanges(r, false))}>
                                    ↩ הפריט הגיע בסוף
                                  </button>
                                ) : (
                                  <button type="button" className="btn-link admin-recv-miss" disabled={busy} onClick={() => onMark(rowChanges(r, true))}>
                                    לא הגיע בכלל
                                  </button>
                                )}
                                {r.missingUnits > 0 && !allMissing && (
                                  <button type="button" className="btn-link" disabled={busy} onClick={() => onMark(rowChanges(r, false))}>
                                    ↩ הכול הגיע
                                  </button>
                                )}
                                {firstOfModel && modelRows.length > 1 && (
                                  <button
                                    type="button"
                                    className={'btn-link' + (modelMissing ? '' : ' admin-recv-miss')}
                                    disabled={busy}
                                    onClick={() => onMark(modelRows.flatMap((m) => rowChanges(m, !modelMissing)))}
                                  >
                                    {modelMissing ? `↩ כל הדגם הגיע (${modelRows.length} צבעים)` : `כל הדגם לא הגיע (${modelRows.length} צבעים)`}
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="num muted">{toMoney(r.item.price)}</td>
                      {sizes.map((s) => (
                        <td key={s} className={'num admin-size' + (isOpen && focus === s ? ' focus' : '')}>
                          {editing && r.qty[s] ? (
                            <div className="admin-recv" dir="ltr">
                              <button
                                type="button"
                                className="admin-recv-btn"
                                aria-label={`עוד יחידה לא הגיעה: ${label}, מידה ${s}`}
                                title="עוד יחידה לא הגיעה"
                                hidden={r.missing[s] >= r.qty[s]}
                                disabled={busy}
                                onClick={() => step(r, s, 'miss')}
                              >
                                −
                              </button>
                              <button
                                type="button"
                                className={'admin-recv-n' + (r.missing[s] ? ' short' : '')}
                                title={`הגיעו ${r.qty[s] - (r.missing[s] ?? 0)} מתוך ${r.qty[s]} — מי הזמין?`}
                                onClick={() => toggle(r.item.id, s)}
                              >
                                {r.qty[s] - (r.missing[s] ?? 0)}/{r.qty[s]}
                              </button>
                              <button
                                type="button"
                                className="admin-recv-btn"
                                aria-label={`יחידה הגיעה בסוף: ${label}, מידה ${s}`}
                                title="יחידה הגיעה בסוף"
                                hidden={!r.missing[s]}
                                disabled={busy}
                                onClick={() => step(r, s, 'back')}
                              >
                                +
                              </button>
                              {pick && pick.id === r.item.id && pick.size === s && (
                                <PickWho
                                  dir={pick.dir}
                                  size={s}
                                  candidates={stepCandidates(r.who[s] ?? [], pick.dir)}
                                  busy={busy}
                                  onPick={(w) => {
                                    setPick(null);
                                    onMark([stepChange(r, s, w, pick.dir)]);
                                  }}
                                  onClose={() => setPick(null)}
                                />
                              )}
                            </div>
                          ) : r.qty[s] ? (
                            <button
                              type="button"
                              className={'admin-size-btn' + (r.missing[s] ? ' admin-short' : '')}
                              title={
                                `מי הזמין ${label} במידה ${s}` + (r.missing[s] ? ` — ${notArrived(r.missing[s])} מתוך ${r.qty[s]}` : '')
                              }
                              onClick={() => toggle(r.item.id, s)}
                            >
                              {r.qty[s]}
                              {r.missing[s] > 0 && (
                                <span className="admin-short-n" dir="ltr">
                                  −{r.missing[s]}
                                </span>
                              )}
                            </button>
                          ) : (
                            ''
                          )}
                        </td>
                      ))}
                      <td className="num strong">
                        {r.units || ''}
                        {r.missingUnits > 0 && <div className="danger small">{notArrived(r.missingUnits)}</div>}
                        {!editing && r.pending !== 0 && (
                          <div className="admin-pending small" title={PENDING_TITLE}>
                            לא נשלח: {signed(r.pending)}
                          </div>
                        )}
                      </td>
                      <td className="num">
                        {r.units ? (
                          r.item.price == null ? (
                            <span className="danger">ללא מחיר</span>
                          ) : (
                            <>
                              {toMoney(r.item.price * (r.units - r.missingUnits))}
                              {r.missingUnits > 0 && <div className="muted small">הוזמן {toMoney(r.item.price * r.units)}</div>}
                            </>
                          )
                        ) : (
                          ''
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className={'admin-who-row' + (sameAsNext ? ' admin-model-more' : '')}>
                        <td className="admin-prod-item admin-who-label small muted">מי הזמין:</td>
                        <td />
                        {sizes.map((s) => {
                          const list = r.who[s];
                          const sizeMissing = r.missing[s] === r.qty[s];
                          return (
                            <td key={s} className={'admin-size admin-who-cell' + (focus === s ? ' focus' : '')}>
                              <div className="admin-who-list">
                                {list?.map((w) => (
                                  <div key={w.fileId}>
                                    <Who w={w} canMark={editing} busy={busy} onSet={(qty) => onMark([{ fileId: w.fileId, id: r.item.id, size: s, qty }])} />
                                  </div>
                                ))}
                                {editing && list && list.length > 1 && (
                                  <button
                                    type="button"
                                    className="btn-link admin-short-size"
                                    disabled={busy}
                                    onClick={() => onMark(rowChanges(r, !sizeMissing, s))}
                                  >
                                    {sizeMissing ? 'ביטול לכולם' : 'לא הגיעה לכולם'}
                                  </button>
                                )}
                              </div>
                            </td>
                          );
                        })}
                        <td />
                        <td />
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
                <td className="num">
                  {sum.units}
                  {sum.missingUnits > 0 && <div className="danger small">{notArrived(sum.missingUnits)}</div>}
                  {!editing && sum.pending !== 0 && (
                    <div className="admin-pending small" title={PENDING_TITLE}>
                      לא נשלח: {signed(sum.pending)}
                    </div>
                  )}
                </td>
                <td className="num">
                  {toMoney(sum.amount)}
                  {sum.missingUnits > 0 && <div className="muted small">הוזמן {toMoney(sum.orderedAmount)}</div>}
                  {sum.unpricedUnits > 0 && <div className="danger small">+{sum.unpricedUnits} ללא מחיר</div>}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {view.missing.length > 0 && (
        <div className="notice notice-warn">
          <span>{view.missing.length} שורות שאינן בקטלוג הנוכחי (לא נספרו כאן):</span>
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

interface PickWhoProps {
  dir: Step;
  size: string;
  candidates: WhoOrdered[];
  busy: boolean;
  onPick: (w: WhoOrdered) => void;
  onClose: () => void;
}

/** Small popover under a size cell: which orderer the missing (or late-arriving) unit belongs to. */
function PickWho({ dir, size, candidates, busy, onPick, onClose }: PickWhoProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Fixed position (the table scrolls horizontally and would clip an absolute popover), clamped to the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = el?.parentElement?.getBoundingClientRect();
    if (!el || !anchor) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - w / 2), window.innerWidth - w - 8);
    const below = anchor.bottom + 4;
    setPos({ top: below + h > window.innerHeight - 8 ? Math.max(8, anchor.top - h - 4) : below, left });
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
    };
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  // Focus the first option once positioned (a hidden element can't take focus).
  useEffect(() => {
    if (pos) ref.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [pos]);

  return (
    <div
      className="admin-pick"
      dir="rtl"
      role="dialog"
      aria-label="בחירת מזמין"
      ref={ref}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
    >
      <div className="admin-pick-title">
        {dir === 'miss' ? 'חסרה יחידה' : 'הגיעה יחידה'} במידה <bdi>{size}</bdi> — {dir === 'miss' ? 'מי לא מקבל/ת?' : 'למי?'}
      </div>
      {candidates.map((w) => (
        <button key={w.fileId} type="button" className="admin-pick-opt" disabled={busy} onClick={() => onPick(w)}>
          <bdi>{w.name}</bdi>
          {(w.qty > 1 || w.missing > 0) && (
            <span className="muted">
              {' '}
              {w.missing ? `(הגיעו ${w.qty - w.missing} מתוך ${w.qty})` : `(הזמין/ה ${w.qty})`}
            </span>
          )}
        </button>
      ))}
      <button type="button" className="btn-link admin-pick-cancel" onClick={onClose}>
        ביטול
      </button>
    </div>
  );
}

interface WhoProps {
  w: WhoOrdered;
  canMark: boolean;
  busy: boolean;
  /** Sets how many of this orderer's units did not arrive (0 = all arrived). */
  onSet: (qty: number) => void;
}

/** One orderer of a size; once the round is closed, a checkbox marks that their units did not arrive. */
function Who({ w, canMark, busy, onSet }: WhoProps) {
  const name = (
    <>
      <bdi>{w.name}</bdi>
      {w.qty > 1 && ` (${w.qty})`}
    </>
  );
  if (!canMark) {
    return (
      <span className={w.missing ? 'admin-who-person missing' : undefined} title={w.missing ? notArrived(w.missing) : undefined}>
        {name}
      </span>
    );
  }
  return (
    <span className={'admin-who-person' + (w.missing ? ' missing' : '')}>
      <label title={w.missing ? 'הגיע בסוף? בטלו את הסימון' : 'סמנו אם לא הגיע למזמין/ה הזה'}>
        <input type="checkbox" checked={w.missing > 0} disabled={busy} onChange={(e) => onSet(e.target.checked ? w.qty : 0)} />
        {name}
      </label>
      {w.missing > 0 && w.qty > 1 && (
        <select
          aria-label="כמה לא הגיעו"
          value={w.missing}
          disabled={busy}
          onChange={(e) => onSet(Number(e.target.value))}
        >
          {Array.from({ length: w.qty }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n === w.qty ? 'כולן לא הגיעו' : notArrived(n)}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}
