import type { Round } from '../lib/source/types';
import { useOrderStore } from '../store/orderStore';
import { RoundChooser } from './RoundChooser';

/** Entry screen (after signing in) when the Drive folder holds more than one order round. */
export function RoundPicker() {
  const rounds = useOrderStore((s) => s.rounds) ?? [];
  const ordered = useOrderStore((s) => s.orderedRounds);
  const loading = useOrderStore((s) => s.loading);
  const status = useOrderStore((s) => s.status);
  const openRound = useOrderStore((s) => s.openRound);
  // Closed rounds without an order: a locked one is still shown (so a late orderer sees it closed), the archive isn't.
  const notOrdered = (r: Round) => Array.isArray(ordered) && (r.locked || r.archived) && !ordered.includes(r.id);
  const shown = ordered === null ? rounds : rounds.filter((r) => !r.archived || (Array.isArray(ordered) && ordered.includes(r.id)));

  return (
    <RoundChooser
      rounds={shown}
      disabled={loading}
      onSelect={(r) => void openRound(r)}
      archiveTitle={Array.isArray(ordered) ? 'ההזמנות שלי בארכיון (צפייה בלבד)' : undefined}
      notOrdered={notOrdered}
    >
      {loading && <div className="muted">טוען סבב…</div>}
      {!loading && status.isError && <div className="status error">{status.message}</div>}
    </RoundChooser>
  );
}
