import type { ReactNode } from 'react';
import { formatSavedAt, todayKey } from '../lib/catalog/text';
import type { Round } from '../lib/source/types';

interface RoundChooserProps {
  rounds: Round[];
  disabled?: boolean;
  onSelect: (round: Round) => void;
  archiveTitle?: string;
  /** Admin page: a "new round" card first in the list. */
  onCreate?: () => void;
  /** Order page: a closed round the signed-in member did not order in (shown muted). */
  notOrdered?: (round: Round) => boolean;
  /** Shown under the cards (loading / errors). */
  children?: ReactNode;
}

/** Round cards — open rounds first, the archive below. Shared by the order page and the admin page. */
export function RoundChooser({
  rounds,
  disabled,
  onSelect,
  archiveTitle = 'ארכיון (צפייה בלבד)',
  onCreate,
  notOrdered,
  children,
}: RoundChooserProps) {
  const active = rounds.filter((r) => !r.archived);
  const archived = rounds.filter((r) => r.archived);
  const today = todayKey();
  // Admin page only: an open round whose closing date came still has to be locked by hand.
  const closingDue = (r: Round) => !!onCreate && !r.locked && !r.archived && !!r.closesOn && r.closesOn <= today;
  const list = (items: Round[], first?: ReactNode) => (
    <div className="round-list">
      {first}
      {items.map((r) => (
        <button
          key={r.id}
          type="button"
          className={'round-card' + (r.archived ? ' round-archived' : '') + (notOrdered?.(r) ? ' round-muted' : '')}
          disabled={disabled}
          onClick={() => onSelect(r)}
        >
          <strong>
            <bdi>{r.name}</bdi>
            {r.draft && <span className="chip chip-warn round-chip">טיוטה</span>}
            {r.locked && !r.archived && <span className="chip chip-warn round-chip">נעול</span>}
            {notOrdered?.(r) && <span className="chip round-chip">לא הזמנת</span>}
            {closingDue(r) && (
              <span className="chip chip-warn round-chip">⏰ {r.closesOn === today ? 'נסגר היום' : 'עבר מועד הסגירה — לנעול'}</span>
            )}
          </strong>
          <span className="muted">נפתח {formatSavedAt(r.createdTime)}</span>
        </button>
      ))}
    </div>
  );
  const createCard = onCreate && (
    <button type="button" className="round-card round-new" disabled={disabled} onClick={onCreate}>
      <strong>+ סבב חדש</strong>
      <span className="muted">קטלוג, תמונות, מחירים ומידות</span>
    </button>
  );

  return (
    <section className="panel round-picker">
      <h2>{onCreate ? 'סבבי הזמנה' : 'בחרו סבב הזמנה'}</h2>
      {active.length || createCard ? list(active, createCard) : <div className="muted">אין כרגע סבבים פתוחים.</div>}
      {archived.length > 0 && (
        <>
          <h3 className="round-archive-title">{archiveTitle}</h3>
          {list(archived)}
        </>
      )}
      {children}
    </section>
  );
}
