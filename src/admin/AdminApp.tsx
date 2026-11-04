import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiPost } from '../lib/api/client';
import type { Round } from '../lib/source/types';
import { RoundChooser } from '../components/RoundChooser';
import { unsavedCatalog } from './CatalogEditor';
import { MembersAdmin } from './MembersAdmin';
import { NewRoundForm } from './NewRoundForm';
import { errText, RoundAdmin } from './RoundAdmin';
import '../styles/admin.css';

/** Leaving the open round (or the page section) with unsaved catalog edits: ask first (they are kept on this device). */
const canLeave = () =>
  !unsavedCatalog.current ||
  window.confirm('יש שינויים בקטלוג שלא נשמרו. לצאת בלי לשמור?\n(הם נשארים במכשיר הזה ויוצעו שוב כשתפתחו את הסבב.)');

/** Opens a round straight away when there is no real choice: a single round, or a single non-archived one. */
function defaultRoundId(rounds: Round[]): string {
  const active = rounds.filter((r) => !r.archived);
  return rounds.length === 1 ? rounds[0].id : active.length === 1 ? active[0].id : '';
}

type View = 'rounds' | 'members';

/** Admin page at /admin: rounds (state, orders) and the list of who may order. */
export function AdminApp() {
  const [admin, setAdmin] = useState<boolean | null>(null);
  // `?view=members` keeps the orderers list open across reloads.
  const [view, setView] = useState<View>(() =>
    new URLSearchParams(window.location.search).get('view') === 'members' ? 'members' : 'rounds',
  );
  const [rounds, setRounds] = useState<Round[] | null>(null);
  // `?round=<id>` keeps the chosen round across reloads and bookmarks, like on the order page.
  const [roundId, setRoundId] = useState(() => new URLSearchParams(window.location.search).get('round') ?? '');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    apiPost<{ admin: boolean }>('/api/admin', { action: 'session' })
      .then((r) => setAdmin(r.admin))
      .catch(() => setAdmin(false));
  }, []);

  // Through the admin API: it includes the drafts the orderers don't see.
  useEffect(() => {
    if (!admin) return;
    let live = true;
    setError('');
    apiPost<{ rounds: Round[] }>('/api/admin', { action: 'rounds' })
      .then(({ rounds: list }) => {
        if (!live) return;
        setRounds(list);
        setRoundId((id) => (list.some((r) => r.id === id) ? id : defaultRoundId(list)));
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) setAdmin(false);
        else setError(errText(err));
      });
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
    if (view === 'members') url.searchParams.set('view', view);
    else url.searchParams.delete('view');
    window.history.replaceState(null, '', url);
  }, [rounds, roundId, view]);

  const onRoundChange = useCallback(
    (id: string, patch: Partial<Round>) => setRounds((list) => list?.map((r) => (r.id === id ? { ...r, ...patch } : r)) ?? null),
    [],
  );
  const onDeleted = useCallback((id: string) => {
    setRounds((list) => list?.filter((r) => r.id !== id) ?? null);
    setRoundId('');
  }, []);
  const onCreated = useCallback((created: Round) => {
    setRounds((list) => [created, ...(list ?? []).filter((r) => r.id !== created.id)]);
    setRoundId(created.id);
    setCreating(false);
  }, []);
  const onSignedOut = useCallback(() => setAdmin(false), []);

  async function logout() {
    if (!canLeave()) return;
    await apiPost('/api/admin', { action: 'logout' }).catch(() => undefined);
    setAdmin(false);
  }

  const toRoundsList = () => {
    if (!canLeave()) return;
    setRoundId('');
    setCreating(false);
  };
  // The rounds tab also leads back to the list from an open round.
  const switchView = (v: View) => {
    if (v !== view) canLeave() && setView(v);
    else if (v === 'rounds' && (roundId || creating)) toRoundsList();
  };

  const round = admin && view === 'rounds' && !creating ? rounds?.find((r) => r.id === roundId) : undefined;

  return (
    <div className="wrap admin">
      <header className="app-header">
        <h1>ניהול הזמנות</h1>
        {admin && (
          <div className="admin-seg" role="tablist">
            <button type="button" role="tab" aria-selected={view === 'rounds'} onClick={() => switchView('rounds')}>
              סבבים
            </button>
            <button type="button" role="tab" aria-selected={view === 'members'} onClick={() => switchView('members')}>
              רשימת מזמינים
            </button>
          </div>
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
      {admin && view === 'rounds' && (round || creating) && (
        <nav className="admin-crumbs" aria-label="מיקום">
          <button type="button" className="btn-link" onClick={toRoundsList}>
            כל הסבבים
          </button>
          <span aria-hidden="true">‹</span>
          <span aria-current="page">{round ? <bdi>{round.name}</bdi> : 'סבב חדש'}</span>
        </nav>
      )}
      {admin === null ? (
        <div className="muted">טוען…</div>
      ) : !admin ? (
        <AdminLogin onSignedIn={() => setAdmin(true)} />
      ) : view === 'members' ? (
        <MembersAdmin onSignedOut={onSignedOut} />
      ) : error ? (
        <div className="status error">{error}</div>
      ) : !rounds ? (
        <div className="muted">טוען סבבים…</div>
      ) : creating ? (
        <NewRoundForm rounds={rounds} onCreated={onCreated} onCancel={() => setCreating(false)} onSignedOut={onSignedOut} />
      ) : round ? (
        <RoundAdmin key={round.id} round={round} onRoundChange={onRoundChange} onDeleted={onDeleted} onSignedOut={onSignedOut} />
      ) : (
        <RoundChooser
          rounds={rounds}
          onSelect={(r) => setRoundId(r.id)}
          onCreate={() => setCreating(true)}
          archiveTitle="ארכיון"
        />
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
