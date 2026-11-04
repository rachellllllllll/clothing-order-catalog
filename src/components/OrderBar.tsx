import { formatDay, formatSavedAt, todayKey, toMoney } from '../lib/catalog/text';
import { useCart, useSendOrder } from '../store/cartHooks';
import { isReadOnly, useOrderStore } from '../store/orderStore';

/** The round's last day to order, as the orderer should read it (nothing once it passed and all is sent). */
function deadlineText(closesOn: string | null, sent: boolean): string {
  if (!closesOn) return '';
  const day = formatDay(closesOn);
  const today = todayKey();
  if (closesOn > today) return (sent ? 'אפשר לעדכן עד ' : 'אפשר להזמין עד ') + day + ' (כולל)';
  if (closesOn === today) return `היום (${day}) הוא היום האחרון להזמנה`;
  return sent ? '' : `המועד האחרון (${day}) עבר — כדאי לשלוח מיד`;
}

/** Whether the signed-in order was sent, has unsent changes, or is still empty — shared by the top bar and the cart. */
export function useOrderStatus() {
  const send = useSendOrder();
  const { totals } = useCart();
  const { submitted, unsent } = send;
  const sent = !!submitted && !unsent;
  const canSend = unsent && (totals.units > 0 || !!submitted);
  const state: 'sent' | 'pending' | 'empty' = sent ? 'sent' : canSend ? 'pending' : 'empty';
  const title = submitted
    ? sent
      ? '✓ ההזמנה נשלחה ' + formatSavedAt(submitted.at)
      : '⚠ יש שינויים שעוד לא נשלחו'
    : canSend
      ? '⚠ ההזמנה עדיין לא נשלחה'
      : 'עוד לא בחרת פריטים';
  return { send, totals, sent, canSend, state, title };
}

/** Top bar of a signed-in order: whether it was sent (or has unsent changes), what's in it, until when, and "send". */
export function OrderBar() {
  const closesOn = useOrderStore((s) => s.round?.closesOn ?? null);
  const readOnly = useOrderStore(isReadOnly);
  const { send, totals, sent, canSend, state, title } = useOrderStatus();
  if (!send.signedIn || readOnly) return null;

  const due = deadlineText(closesOn, sent);

  return (
    <div className={'notice order-bar order-bar-' + state} role="status">
      <div className="order-bar-text">
        <strong>{title}</strong>
        {totals.units > 0 && (
          <span>
            {totals.units === 1 ? 'יחידה אחת' : `${totals.units} יחידות`} · <bdi>{toMoney(totals.amount)}</bdi>
          </span>
        )}
        {due && <span className="order-bar-due">{due}</span>}
      </div>
      {canSend && (
        <div className="notice-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={!!send.disabledReason}
            title={send.disabledReason}
            onClick={() => void send.send()}
          >
            {send.label}
          </button>
        </div>
      )}
    </div>
  );
}
