import { useEffect, useRef, useState } from 'react';
import { groupLinesByModel } from '../lib/catalog/selectors';
import { formatSavedAt, normalizeText, toMoney } from '../lib/catalog/text';
import type { CartLine } from '../lib/catalog/types';
import { useCart, useExportOrder, useSendOrder } from '../store/cartHooks';
import { useImage } from '../store/hooks';
import { isReadOnly, useOrderStore } from '../store/orderStore';
import { PrintArea } from './PrintArea';
import { ProductImage } from './ProductImage';

/** Waits until every image inside `root` finished loading (or failed), at most `timeoutMs`. */
function imagesSettled(root: HTMLElement, timeoutMs = 8000): Promise<void> {
  const pending = Array.from(root.querySelectorAll('img')).filter((img) => !img.complete);
  const all = Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }),
    ),
  ).then(() => undefined);
  return Promise.race([all, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

function flashCard(card: Element) {
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('card-flash');
  void (card as HTMLElement).offsetWidth; // restart the animation
  card.classList.add('card-flash');
  setTimeout(() => card.classList.remove('card-flash'), 1600);
}

function goToModelCard(modelKey: string) {
  const find = () => document.querySelector(`.card[data-model-key="${CSS.escape(modelKey)}"]`);
  const store = useOrderStore.getState();
  store.setCartOpen(false);

  const card = find();
  if (card) {
    flashCard(card);
    return;
  }
  // The model may be hidden by an active search/size filter — clear them and retry after render.
  store.setSearch('');
  store.clearSizeFilter();
  setTimeout(() => {
    const retry = find();
    if (retry) flashCard(retry);
  }, 0);
}

export function CartModal() {
  const open = useOrderStore((s) => s.cartOpen);
  const setCartOpen = useOrderStore((s) => s.setCartOpen);
  const clearAll = useOrderStore((s) => s.clearAll);
  const readOnly = useOrderStore(isReadOnly);
  const { lines, totals } = useCart();
  const { exportOrder, disabledReason } = useExportOrder();
  const send = useSendOrder();
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (!printing) return;
    const root = document.getElementById('printArea');
    if (!root) return;
    let cancelled = false;
    void imagesSettled(root).then(() => {
      if (cancelled) return;
      window.print();
      setPrinting(false);
    });
    return () => {
      cancelled = true;
    };
  }, [printing]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCartOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setCartOpen]);

  if (!open) return null;

  const byModel = groupLinesByModel(lines);

  function onEmpty() {
    if (window.confirm('האם לרוקן את הסל?')) clearAll();
  }

  return (
    <div className="cart-modal-overlay" onClick={(e) => e.target === e.currentTarget && setCartOpen(false)}>
      <div className="cart-modal" role="dialog" aria-label="סל קניות">
        <div className="cart-modal-header">
          <h2>סל קניות</h2>
          <div className="cart-modal-actions">
            {send.signedIn && (
              <button
                type="button"
                className="btn-primary"
                disabled={!!send.disabledReason}
                title={send.disabledReason}
                onClick={() => void send.send()}
              >
                {send.label}
              </button>
            )}
            <button
              type="button"
              className={send.signedIn ? 'btn-secondary' : 'btn-primary'}
              disabled={!!disabledReason}
              title={disabledReason}
              onClick={exportOrder}
            >
              הורדת קובץ הזמנה
            </button>
            {!readOnly && (
              <button type="button" className="btn-secondary" disabled={totals.units === 0} onClick={onEmpty}>
                🗑 רוקן סל
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={() => setPrinting(true)}>
              🖨 הדפס
            </button>
            <button type="button" className="btn-secondary" onClick={() => setCartOpen(false)}>
              ✕ סגור
            </button>
          </div>
        </div>
        {disabledReason && totals.units > 0 && !send.signedIn && <div className="muted">{disabledReason}</div>}
        {send.signedIn && <SendStatus />}
        <SaveStatusText />
        <div className="cart-list">
          {byModel.size === 0 ? (
            <div className="muted">הסל ריק.</div>
          ) : (
            Array.from(byModel, ([model, modelLines]) => <CartGroup key={model} model={model} lines={modelLines} />)
          )}
        </div>
      </div>
      {printing && <PrintArea />}
    </div>
  );
}

function CartGroup({ model, lines }: { model: string; lines: CartLine[] }) {
  const modelKey = normalizeText(model);
  const image = useImage(modelKey);
  const removeLine = useOrderStore((s) => s.removeLine);
  const readOnly = useOrderStore(isReadOnly);
  const units = lines.reduce((s, l) => s + l.qty, 0);
  const amount = lines.reduce((s, l) => (l.subtotal != null ? s + l.subtotal : s), 0);
  const hasNoPrice = lines.some((l) => l.price == null);

  return (
    <div className="cart-group">
      <div className="cart-group-head" title="מעבר למוצר בקטלוג" onClick={() => goToModelCard(modelKey)}>
        <div className="cart-group-thumb">
          <ProductImage src={image?.thumb} alt={model} placeholder="אין" placeholderClassName="tiny-placeholder" />
        </div>
        <div className="cart-group-info">
          <strong>{model}</strong>
          <div className="muted">
            {units} יחידות{hasNoPrice ? '' : ' | ' + toMoney(amount)}
          </div>
        </div>
      </div>
      <div className="cart-group-rows">
        {lines.map((l) => (
          <div className="cart-group-row" key={l.itemId + '|' + l.size}>
            <span className="chip">{l.color}</span>
            <span>
              {l.size} × {l.qty}
            </span>
            <span className="row-price">{l.subtotal == null ? 'ללא מחיר' : toMoney(l.subtotal)}</span>
            {!readOnly && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                aria-label="הסרה"
                title="הסרה מהסל"
                onClick={() => removeLine(l.itemId, l.size)}
              >
                🗑
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** "Item removed – undo" notice after removing a cart line; disappears on its own after a few seconds. */
export function RemovedToast() {
  const removed = useOrderStore((s) => s.lastRemoved);
  const undoRemove = useOrderStore((s) => s.undoRemove);
  const dismissRemoved = useOrderStore((s) => s.dismissRemoved);

  useEffect(() => {
    if (!removed) return;
    const t = window.setTimeout(dismissRemoved, 5000);
    return () => window.clearTimeout(t);
  }, [removed, dismissRemoved]);

  if (!removed) return null;

  return (
    <div className="toast" role="status">
      <span>הפריט הוסר</span>
      <button type="button" className="toast-undo" onClick={undoRemove}>
        בטל
      </button>
    </div>
  );
}

/** Save state line inside the cart modal (the floating indicator is hidden behind the overlay). */
function SaveStatusText() {
  const save = useOrderStore((s) => s.save);
  const signedIn = useOrderStore((s) => !!s.account);
  const sync = useOrderStore((s) => s.sync);
  if (signedIn) {
    if (sync.status === 'error') return <div className="muted danger">⚠ לא נשמר: {sync.error}</div>;
    if (!sync.savedAt) return null;
    return <div className="muted save-ok">✓ נשמר אוטומטית · עודכן {formatSavedAt(sync.savedAt)}</div>;
  }
  if (save.failed) return <div className="muted danger">⚠ השמירה במכשיר נכשלה — הורידו את קובץ ההזמנה כדי לא לאבד אותה.</div>;
  if (!save.savedAt) return null;
  return (
    <div className="muted save-ok">
      ✓ נשמר אוטומטית במכשיר הזה · עודכן {formatSavedAt(save.savedAt)}
    </div>
  );
}

/** "Sent on …" / "changes not sent yet" for a signed-in Drive order. */
export function SendStatus() {
  const { submitted, unsent } = useSendOrder();
  if (!submitted) return <div className="send-status pending">ההזמנה עדיין לא נשלחה.</div>;
  return (
    <div className={'send-status' + (unsent ? ' pending' : ' sent')}>
      ✓ ההזמנה נשלחה {formatSavedAt(submitted.at)}
      {unsent && ' · ⚠ יש שינויים שלא נשלחו'}
    </div>
  );
}

/** Small "saved" pill next to the floating cart button; pulses on every save. */
export function SaveIndicator() {
  const save = useOrderStore((s) => s.save);
  const signedIn = useOrderStore((s) => !!s.account);
  const sync = useOrderStore((s) => s.sync);
  if (signedIn) {
    if (sync.status === 'saving') return <div className="save-indicator save-busy">שומר…</div>;
    if (sync.status === 'error') {
      return (
        <div className="save-indicator save-failed" role="status" title={sync.error ?? ''}>
          ⚠ לא נשמר — מנסה שוב
        </div>
      );
    }
    if (sync.status !== 'saved' || !sync.savedAt) return null;
    return (
      <div key={sync.savedAt} className="save-indicator" title={'עודכן ' + formatSavedAt(sync.savedAt)}>
        נשמר ✓
      </div>
    );
  }
  if (save.failed) {
    return (
      <div className="save-indicator save-failed" role="status">
        ⚠ לא נשמר במכשיר
      </div>
    );
  }
  if (!save.savedAt) return null;
  return (
    <div key={save.savedAt} className="save-indicator" title={'עודכן ' + formatSavedAt(save.savedAt)}>
      נשמר אוטומטית במכשיר הזה ✓
    </div>
  );
}

export function CartFab() {
  const setCartOpen = useOrderStore((s) => s.setCartOpen);
  const catalog = useOrderStore((s) => s.catalog);
  const { totals } = useCart();
  const btnRef = useRef<HTMLButtonElement>(null);
  const prev = useRef({ catalog, units: totals.units });
  const timer = useRef<number | undefined>(undefined);

  // Briefly outline the button in green whenever units are added (not when a catalog loads).
  useEffect(() => {
    const grew = catalog === prev.current.catalog && totals.units > prev.current.units;
    prev.current = { catalog, units: totals.units };
    const btn = btnRef.current;
    if (!grew || !btn) return;
    btn.classList.add('fab-flash');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => btn.classList.remove('fab-flash'), 700);
  }, [catalog, totals.units]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button ref={btnRef} type="button" className="fab-cart" title="סל קניות" onClick={() => setCartOpen(true)}>
      🛒{totals.units > 0 && <span className="fab-badge">{totals.units}</span>}
    </button>
  );
}
