import { useMemo } from 'react';
import { cartLines, cartTotals, type CartTotals } from '../lib/catalog/selectors';
import { linesKey } from '../lib/catalog/draft';
import { buildOrderWorkbook, downloadBlob, exportFileName } from '../lib/catalog/exportOrder';
import { safeText, toMoney } from '../lib/catalog/text';
import type { CartLine } from '../lib/catalog/types';
import { isReadOnly, useOrderStore } from './orderStore';
import { submitOrder } from './orderSync';

export function useCart(): { lines: CartLine[]; totals: CartTotals } {
  const catalog = useOrderStore((s) => s.catalog);
  const qty = useOrderStore((s) => s.qty);
  return useMemo(() => {
    const lines = catalog ? cartLines(catalog, qty) : [];
    return { lines, totals: cartTotals(lines) };
  }, [catalog, qty]);
}

/** Export state + action, shared by the controls panel and the cart modal. */
export function useExportOrder() {
  const hasCatalog = useOrderStore((s) => !!s.catalog);
  const hasSigner = useOrderStore((s) => safeText(s.signer).length > 0);
  const { totals } = useCart();

  let disabledReason = '';
  if (!hasCatalog) disabledReason = 'הקטלוג עדיין לא נטען';
  else if (totals.units === 0) disabledReason = 'הסל ריק';
  else if (!hasSigner) disabledReason = 'יש למלא שם מזמין לפני ההורדה';

  async function exportOrder() {
    const { source, catalog, qty, signer, account, setStatus } = useOrderStore.getState();
    if (!source || !catalog) return;
    try {
      const blob = await buildOrderWorkbook(source.excelData, catalog, qty, signer);
      const name = exportFileName(source.excelName, signer);
      downloadBlob(blob, name);
      setStatus('קובץ ההזמנה הורד: ', false, { fileName: name, after: account ? '' : ' — שלחו אותו אליי.' });
    } catch (err) {
      console.error(err);
      setStatus('שגיאה ביצירת קובץ ההזמנה: ' + (err instanceof Error ? err.message : String(err)), true);
    }
  }

  return { exportOrder, disabledReason };
}

/** "Send order" state + action for a signed-in Drive order (shared by the controls panel and the cart). */
export function useSendOrder() {
  const signedIn = useOrderStore((s) => s.source?.kind === 'drive' && !!s.account);
  const readOnly = useOrderStore(isReadOnly);
  const conflict = useOrderStore((s) => !!s.conflict);
  const submitted = useOrderStore((s) => s.sync.submitted);
  const saving = useOrderStore((s) => s.sync.status === 'saving');
  const { lines, totals } = useCart();

  const unsent = useMemo(
    () => !submitted || linesKey(lines.map((l) => ({ id: l.itemId, size: l.size, qty: l.qty }))) !== linesKey(submitted.lines),
    [lines, submitted],
  );

  let disabledReason = '';
  if (readOnly) disabledReason = 'הסבב נעול לשינויים';
  else if (conflict) disabledReason = 'יש לבחור קודם איזו גרסה של ההזמנה לשמור';
  else if (!unsent) disabledReason = 'ההזמנה נשלחה ואין בה שינויים חדשים';
  else if (totals.units === 0 && !submitted) disabledReason = 'הסל ריק';
  else if (saving) disabledReason = 'שומר…';

  async function send() {
    const question =
      totals.units === 0
        ? 'לשלוח הזמנה ריקה? זה מבטל את ההזמנה ששלחת.'
        : `לשלוח את ההזמנה? (${totals.units} יחידות${totals.amount ? ', ' + toMoney(totals.amount) : ''})`;
    if (window.confirm(question)) await submitOrder();
  }

  return { signedIn, send, disabledReason, unsent, submitted, label: submitted ? 'שליחת עדכון' : 'שלח הזמנה' };
}
