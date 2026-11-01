import { useOrderStore } from '../store/orderStore';
import { RoundChooser } from './RoundChooser';

/** Entry screen (after signing in) when the Drive folder holds more than one order round. */
export function RoundPicker() {
  const rounds = useOrderStore((s) => s.rounds) ?? [];
  const loading = useOrderStore((s) => s.loading);
  const status = useOrderStore((s) => s.status);
  const openRound = useOrderStore((s) => s.openRound);

  return (
    <RoundChooser rounds={rounds} disabled={loading} onSelect={(r) => void openRound(r)}>
      {loading && <div className="muted">טוען סבב…</div>}
      {!loading && status.isError && <div className="status error">{status.message}</div>}
    </RoundChooser>
  );
}
