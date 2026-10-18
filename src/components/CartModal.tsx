import { useEffect, useState } from 'react';
import { groupLinesByModel } from '../lib/catalog/selectors';
import { normalizeText, toMoney } from '../lib/catalog/text';
import type { CartLine } from '../lib/catalog/types';
import { useCart, useExportOrder } from '../store/cartHooks';
import { useImage } from '../store/hooks';
import { useOrderStore } from '../store/orderStore';
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
  const { lines, totals } = useCart();
  const { exportOrder, disabledReason } = useExportOrder();
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
            <button
              type="button"
              className="btn-primary"
              disabled={!!disabledReason}
              title={disabledReason}
              onClick={exportOrder}
            >
              הורדת קובץ הזמנה
            </button>
            <button type="button" className="btn-secondary" disabled={totals.units === 0} onClick={onEmpty}>
              רוקן סל
            </button>
            <button type="button" className="btn-secondary" onClick={() => setPrinting(true)}>
              🖨 הדפס
            </button>
            <button type="button" className="btn-secondary" onClick={() => setCartOpen(false)}>
              ✕ סגור
            </button>
          </div>
        </div>
        {disabledReason && totals.units > 0 && <div className="muted">{disabledReason}</div>}
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
            <button
              type="button"
              className="btn-secondary btn-sm"
              aria-label="הסרה"
              onClick={() => removeLine(l.itemId, l.size)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CartFab() {
  const setCartOpen = useOrderStore((s) => s.setCartOpen);
  const { totals } = useCart();
  return (
    <button type="button" className="fab-cart" title="סל קניות" onClick={() => setCartOpen(true)}>
      🛒{totals.units > 0 && <span className="fab-badge">{totals.units}</span>}
    </button>
  );
}
