import { useMemo } from 'react';
import { cartLines, cartTotals, withShortages, type CartTotals } from '../lib/catalog/selectors';
import { linesKey } from '../lib/catalog/draft';
import { toMoney } from '../lib/catalog/text';
import type { CartLine } from '../lib/catalog/types';
import { isReadOnly, useOrderStore } from './orderStore';
import { submitOrder } from './orderSync';

export function useCart(): { lines: CartLine[]; totals: CartTotals } {
  const catalog = useOrderStore((s) => s.catalog);
  const qty = useOrderStore((s) => s.qty);
  const shortages = useOrderStore((s) => s.shortages);
  return useMemo(() => {
    const lines = catalog ? withShortages(cartLines(catalog, qty), shortages) : [];
    return { lines, totals: cartTotals(lines) };
  }, [catalog, qty, shortages]);
}

/** "Send order" state + action for a signed-in Drive order (shared by the order bar and the cart). */
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
