import { useCallback, useEffect, useState } from 'react';
import type { RoundState } from '../../api/_types';
import { apiPost } from '../lib/api/client';
import { loadDriveRounds } from '../lib/source/drive';
import type { Round } from '../lib/source/types';
import { RoundChooser } from '../components/RoundChooser';
import { errText, RoundAdmin } from './RoundAdmin';
import '../styles/admin.css';

/** Opens a round straight away when there is no real choice: a single round, or a single non-archived one. */
function defaultRoundId(rounds: Round[]): string {
  const active = rounds.filter((r) => !r.archived);
  return rounds.length === 1 ? rounds[0].id : active.length === 1 ? active[0].id : '';
}

/** Admin page at /admin: round state, orderers list, PIN resets and the combined Excel. */
export function AdminApp() {
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [rounds, setRounds] = useState<Round[] | null>(null);
  // `?round=<id>` keeps the chosen round across reloads and bookmarks, like on the order page.
  const [roundId, setRoundId] = useState(() => new URLSearchParams(window.location.search).get('round') ?? '');
  const [error, setError] = useState('');

  useEffect(() => {
    apiPost<{ admin: boolean }>('/api/admin', { action: 'session' })
      .then((r) => setAdmin(r.admin))
      .catch(() => setAdmin(false));
  }, []);

  useEffect(() => {
    if (!admin) return;
    let live = true;
    setError('');
    loadDriveRounds()
      .then((list) => {
        if (!live) return;
        setRounds(list);
        setRoundId((id) => (list.some((r) => r.id === id) ? id : defaultRoundId(list)));
      })
      .catch((err) => live && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [admin]);

  // Skip until the rounds are known, so the initial `?round=` survives until it has been read.
  useEffect(() => {
    if (!rounds) return;
    const url = new URL(window.location.href);
    if (roundId) url.searchParams.set('round', roundId);
    else url.searchParams.delete('round');
    window.history.replaceState(null, '', url);
  }, [rounds, roundId]);

  const onRoundState = useCallback(
    (id: string, state: RoundState) => setRounds((list) => list?.map((r) => (r.id === id ? { ...r, ...state } : r)) ?? null),
    [],
  );
  const onSignedOut = useCallback(() => setAdmin(false), []);

  async function logout() {
    await apiPost('/api/admin', { action: 'logout' }).catch(() => undefined);
    setAdmin(false);
  }

  const round = admin ? rounds?.find((r) => r.id === roundId) : undefined;
  const canSwitchRound = (rounds?.length ?? 0) > 1;

  return (
    <div className="wrap admin">
      <header className="app-header">
        <h1>ניהול הזמנות</h1>
        {round && (
          <span className="round-name">
            סבב: <bdi>{round.name}</bdi>
          </span>
        )}
        {round && canSwitchRound && (
          <button type="button" className="btn-secondary btn-sm" onClick={() => setRoundId('')}>
            החלפת סבב
          </button>
        )}
        <a className="admin-home-link" href={round ? '/?round=' + encodeURIComponent(round.id) : '/'}>
          לממשק ההזמנות ←
        </a>
        {admin && (
          <button type="button" className="btn-secondary btn-sm" onClick={() => void logout()}>
            יציאה
          </button>
        )}
      </header>
      {admin === null ? (
        <div className="muted">טוען…</div>
      ) : !admin ? (
        <AdminLogin onSignedIn={() => setAdmin(true)} />
      ) : error ? (
        <div className="status error">{error}</div>
      ) : !rounds ? (
        <div className="muted">טוען סבבים…</div>
      ) : !rounds.length ? (
        <div className="muted">אין סבבים בתיקיית הקטלוג.</div>
      ) : round ? (
        <RoundAdmin key={round.id} round={round} onRoundState={onRoundState} onSignedOut={onSignedOut} />
      ) : (
        <RoundChooser rounds={rounds} onSelect={(r) => setRoundId(r.id)} archiveTitle="ארכיון" />
      )}
    </div>
  );
}

function AdminLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiPost('/api/admin', { action: 'login', password });
      onSignedIn();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel login-panel">
      <h2>כניסת מנהל</h2>
      <form className="login-form" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor="adminPassword">סיסמה</label>
          <input
            id="adminPassword"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary" disabled={!password || busy}>
          כניסה
        </button>
      </form>
      {error && <div className="status error">{error}</div>}
    </section>
  );
}
