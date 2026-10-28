import type { ReactNode } from 'react';
import { formatSavedAt } from '../lib/catalog/text';
import type { Round } from '../lib/source/types';

interface RoundChooserProps {
  rounds: Round[];
  disabled?: boolean;
  onSelect: (round: Round) => void;
  /** Extra line on a round's card (e.g. who is signed in to it). */
  detail?: (round: Round) => ReactNode;
  archiveTitle?: string;
  /** Shown under the cards (loading / errors). */
  children?: ReactNode;
}

/** Round cards — open rounds first, the archive below. Shared by the order page and the admin page. */
export function RoundChooser({
  rounds,
  disabled,
  onSelect,
  detail,
  archiveTitle = 'ארכיון (צפייה בלבד)',
  children,
}: RoundChooserProps) {
  const active = rounds.filter((r) => !r.archived);
  const archived = rounds.filter((r) => r.archived);
  const list = (items: Round[]) => (
    <div className="round-list">
      {items.map((r) => (
        <button
          key={r.id}
          type="button"
          className={'round-card' + (r.archived ? ' round-archived' : '')}
          disabled={disabled}
          onClick={() => onSelect(r)}
        >
          <strong>
            <bdi>{r.name}</bdi>
            {r.locked && !r.archived && <span className="chip chip-warn round-chip">נעול</span>}
          </strong>
          <span className="muted">נפתח {formatSavedAt(r.createdTime)}</span>
          {detail?.(r)}
        </button>
      ))}
    </div>
  );

  return (
    <section className="panel round-picker">
      <h2>בחרו סבב הזמנה</h2>
      {active.length ? list(active) : <div className="muted">אין כרגע סבבים פתוחים.</div>}
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
