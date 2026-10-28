import { useState } from 'react';
import type { DraftLine } from '../lib/catalog/draft';
import { formatSavedAt } from '../lib/catalog/text';
import { isReadOnly, useOrderStore, type MissingNotice } from '../store/orderStore';
import { resolveConflict } from '../store/orderSync';

/** Banners shown after a catalog loads: "continue your order?" and "some items are gone". */
export function OrderNotices() {
  const missing = useOrderStore((s) => s.missingNotice);
  return (
    <>
      <ReadOnlyBanner />
      <ConflictBanner />
      <ResumeBanner />
      {missing && <MissingBanner key={missing.origin} notice={missing} />}
    </>
  );
}

function ReadOnlyBanner() {
  const round = useOrderStore((s) => s.round);
  if (!round || !(round.locked || round.archived)) return null;
  return (
    <div className="notice notice-warn" role="status">
      <span>{round.archived ? 'הסבב הזה בארכיון — צפייה בלבד.' : 'הסבב נעול לשינויים — צפייה בלבד.'}</span>
    </div>
  );
}

const unitsIn = (lines: readonly { qty: number }[]) => lines.reduce((s, l) => s + l.qty, 0);

function ConflictBanner() {
  const conflict = useOrderStore((s) => s.conflict);
  if (!conflict) return null;
  return (
    <div className="notice notice-warn" role="alert">
      <span>
        ההזמנה שלך עודכנה במכשיר אחר ({formatSavedAt(conflict.server.updatedAt)}), ובמכשיר הזה יש שינויים שלא נשמרו.
        איזו גרסה לשמור? (מוצגת כעת: הגרסה מהמכשיר הזה)
      </span>
      <div className="notice-actions">
        <button type="button" className="btn-primary btn-sm" onClick={() => resolveConflict('mine')}>
          מהמכשיר הזה ({unitsIn(conflict.mine)} יחידות)
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => resolveConflict('server')}>
          מהמכשיר האחר ({unitsIn(conflict.server.lines)} יחידות)
        </button>
      </div>
    </div>
  );
}

function ResumeBanner() {
  const notice = useOrderStore((s) => s.resumeNotice);
  const readOnly = useOrderStore(isReadOnly);
  const dismissResume = useOrderStore((s) => s.dismissResume);
  const startNewOrder = useOrderStore((s) => s.startNewOrder);
  if (!notice || readOnly) return null;

  function onStartNew() {
    if (window.confirm('ההזמנה שהתחלת תימחק. להתחיל הזמנה חדשה?')) startNewOrder();
  }

  return (
    <div className="notice" role="status">
      <span>
        יש לך הזמנה שהתחלת ({notice.units} יחידות, עודכנה {formatSavedAt(notice.updatedAt)})
      </span>
      <div className="notice-actions">
        <button type="button" className="btn-primary btn-sm" onClick={dismissResume}>
          המשך
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={onStartNew}>
          התחל הזמנה חדשה
        </button>
      </div>
    </div>
  );
}

function missingText({ origin, lines }: MissingNotice): string {
  const one = lines.length === 1;
  if (origin === 'file') {
    return one ? 'פריט אחד מהקובץ לא נמצא בקטלוג' : `${lines.length} פריטים מהקובץ לא נמצאו בקטלוג`;
  }
  return one ? 'פריט אחד מההזמנה שלך הוסר מהקטלוג' : `${lines.length} פריטים מההזמנה שלך הוסרו מהקטלוג`;
}

function lineLabel(l: DraftLine): string {
  return [l.model, l.color, 'מידה ' + l.size].filter(Boolean).join(' · ') + ' × ' + l.qty;
}

function MissingBanner({ notice }: { notice: MissingNotice }) {
  const dismissMissing = useOrderStore((s) => s.dismissMissing);
  const [open, setOpen] = useState(false);

  return (
    <div className="notice notice-warn" role="status">
      <span>{missingText(notice)}</span>
      <div className="notice-actions">
        <button type="button" className="btn-secondary btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'הסתר' : 'הצג אילו'}
        </button>
        <button type="button" className="btn-secondary btn-sm" aria-label="סגירה" onClick={dismissMissing}>
          ✕
        </button>
      </div>
      {open && (
        <ul className="notice-list">
          {notice.lines.map((l) => (
            <li key={l.id + '|' + l.size}>
              <bdi>{lineLabel(l)}</bdi>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
