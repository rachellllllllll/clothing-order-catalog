import type { Round } from '../lib/source/types';
import { useOrderStore } from '../store/orderStore';
import { readSession } from '../store/orderSync';
import { RoundChooser } from './RoundChooser';

function signedInAs(round: Round) {
  const session = readSession(round.id);
  return (
    session && (
      <span className="round-draft">
        נכנסת בשם <bdi>{session.name}</bdi>
      </span>
    )
  );
}

/** Entry screen when the Drive folder holds more than one order round. */
export function RoundPicker() {
  const rounds = useOrderStore((s) => s.rounds) ?? [];
  const loading = useOrderStore((s) => s.loading);
  const status = useOrderStore((s) => s.status);
  const openRound = useOrderStore((s) => s.openRound);

  return (
    <RoundChooser rounds={rounds} disabled={loading} onSelect={(r) => void openRound(r)} detail={signedInAs}>
      {loading && <div className="muted">טוען סבב…</div>}
      {!loading && status.isError && <div className="status error">{status.message}</div>}
    </RoundChooser>
  );
}
