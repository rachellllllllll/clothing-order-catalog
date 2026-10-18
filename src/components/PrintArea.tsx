import { createPortal } from 'react-dom';
import { groupLinesByModel } from '../lib/catalog/selectors';
import { normalizeText, toMoney } from '../lib/catalog/text';
import type { CartLine } from '../lib/catalog/types';
import { useCart } from '../store/cartHooks';
import { useOrderStore } from '../store/orderStore';

const NoPrice = () => <span className="no-price">ללא מחיר</span>;

/** Printable order summary, rendered into #printArea (the only element visible when printing). */
export function PrintArea() {
  const { lines, totals } = useCart();
  const signer = useOrderStore((s) => s.signer);
  const excelName = useOrderStore((s) => s.source?.excelName ?? '');
  const images = useOrderStore((s) => s.source?.images);
  const target = document.getElementById('printArea');
  if (!target) return null;

  const byModel = groupLinesByModel(lines);
  const models = Array.from(byModel.keys()).sort((a, b) => a.localeCompare(b, 'he'));
  const hasAnyNotes = lines.some((l) => l.notes);

  const content = !lines.length ? (
    <p>הסל ריק.</p>
  ) : (
    <div>
      <div className="print-header">
        <h2 className="print-title">סיכום הזמנה</h2>
        <div className="print-meta">
          תאריך: {new Date().toLocaleDateString('he-IL')} | מזמין: {signer || '-'} | קובץ מקור:{' '}
          {excelName.replace(/\.xlsx?$/i, '') || '-'}
        </div>
      </div>
      <div className="print-summary">
        <div className="cell">
          דגמים<b>{models.length}</b>
        </div>
        <div className="cell">
          יחידות<b>{totals.units}</b>
        </div>
        <div className="cell">
          סה"כ לתשלום<b>{toMoney(totals.amount)}</b>
        </div>
        <div className="cell">
          יחידות ללא מחיר<b>{totals.unpricedUnits}</b>
        </div>
      </div>
      {models.map((model) => (
        <PrintGroup
          key={model}
          model={model}
          lines={byModel.get(model)!}
          thumb={images?.get(normalizeText(model))?.thumb}
          hasAnyNotes={hasAnyNotes}
        />
      ))}
    </div>
  );

  return createPortal(content, target);
}

function PrintGroup({
  model,
  lines,
  thumb,
  hasAnyNotes,
}: {
  model: string;
  lines: CartLine[];
  thumb: string | undefined;
  hasAnyNotes: boolean;
}) {
  const total = lines.reduce((s, l) => (l.subtotal != null ? s + l.subtotal : s), 0);
  const units = lines.reduce((s, l) => s + l.qty, 0);
  return (
    <div className="print-group">
      {thumb && <img className="pg-thumb" src={thumb} alt="" referrerPolicy="no-referrer" />}
      <div className="pg-content">
        <div className="pg-title">
          <strong>{model}</strong>
          <div className="pg-sub">
            {units} יחידות | {toMoney(total)}
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>צבע</th>
              <th>מידה</th>
              <th>כמות</th>
              <th>מחיר יח'</th>
              <th>סה"כ</th>
              {hasAnyNotes && <th>הערה</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.itemId + '|' + l.size}>
                <td>{l.color}</td>
                <td>{l.size}</td>
                <td>{l.qty}</td>
                <td>{l.price == null ? <NoPrice /> : toMoney(l.price)}</td>
                <td>{l.subtotal == null ? <NoPrice /> : toMoney(l.subtotal)}</td>
                {hasAnyNotes && <td>{l.notes}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
