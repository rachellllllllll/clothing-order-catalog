import { useMemo } from 'react';
import { cartLines, cartTotals, type CartTotals } from '../lib/catalog/selectors';
import { buildOrderWorkbook, downloadBlob, exportFileName } from '../lib/catalog/exportOrder';
import { safeText } from '../lib/catalog/text';
import type { CartLine } from '../lib/catalog/types';
import { useOrderStore } from './orderStore';

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
    const { source, catalog, qty, signer, setStatus } = useOrderStore.getState();
    if (!source || !catalog) return;
    try {
      const blob = await buildOrderWorkbook(source.excelData, catalog, qty, signer);
      const name = exportFileName(source.excelName, signer);
      downloadBlob(blob, name);
      setStatus('קובץ ההזמנה הורד: ' + name + ' — שלחו אותו אליי.');
    } catch (err) {
      console.error(err);
      setStatus('שגיאה ביצירת קובץ ההזמנה: ' + (err instanceof Error ? err.message : String(err)), true);
    }
  }

  return { exportOrder, disabledReason };
}
