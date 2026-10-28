import { useEffect } from 'react';
import { CartFab, CartModal, RemovedToast, SaveIndicator } from './components/CartModal';
import { Catalog } from './components/Catalog';
import { ControlsPanel } from './components/ControlsPanel';
import { FilterBar } from './components/FilterBar';
import { Lightbox } from './components/Lightbox';
import { LoginPanel } from './components/LoginPanel';
import { OrderNotices } from './components/OrderNotices';
import { RoundPicker } from './components/RoundPicker';
import { DriveNotConfiguredError } from './lib/source/drive';
import { useOrderStore } from './store/orderStore';
import './store/orderSync';

const params = new URLSearchParams(window.location.search);

/** The local-folder picker is a development tool; `?local` enables it on a deployed site too. */
const allowLocalFolder = import.meta.env.DEV || params.has('local');

/** `?round=<id>` keeps the chosen round across reloads and bookmarks. */
const initialRoundId = params.get('round');

function setRoundParam(roundId: string | null) {
  const url = new URL(window.location.href);
  if (roundId) url.searchParams.set('round', roundId);
  else url.searchParams.delete('round');
  window.history.replaceState(null, '', url);
}

let initialLoadStarted = false;

async function loadInitialCatalog() {
  if (initialLoadStarted) return;
  initialLoadStarted = true;

  const { loadRounds, openRound, setStatus } = useOrderStore.getState();
  try {
    const rounds = await loadRounds();
    if (!rounds.length) {
      setStatus('לא נמצאו סבבי הזמנה בתיקיית הדרייב.', true);
      return;
    }
    const active = rounds.filter((r) => !r.archived);
    const wanted = rounds.find((r) => r.id === initialRoundId) ?? (active.length === 1 && rounds.length === 1 ? active[0] : null);
    if (wanted) await openRound(wanted);
  } catch (err) {
    console.error(err);
    if (err instanceof DriveNotConfiguredError && allowLocalFolder) setStatus('בחרו תיקייה מקומית (אקסל + תמונות).');
    else setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

export function App() {
  const overlayOpen = useOrderStore((s) => s.cartOpen || s.lightbox !== null);
  const rounds = useOrderStore((s) => s.rounds);
  const round = useOrderStore((s) => s.round);
  const hasCatalog = useOrderStore((s) => !!s.catalog);
  const needsLogin = useOrderStore((s) => s.source?.kind === 'drive' && !s.account);
  const closeRound = useOrderStore((s) => s.closeRound);
  const canSwitchRound = (rounds?.length ?? 0) > 1 || !!rounds?.[0]?.archived;
  const showPicker = canSwitchRound && !hasCatalog;

  useEffect(() => {
    void loadInitialCatalog();
  }, []);

  useEffect(() => {
    document.body.classList.toggle('no-scroll', overlayOpen);
  }, [overlayOpen]);

  // Skip until the rounds are known, so the initial `?round=` survives until it has been read.
  useEffect(() => {
    if (rounds) setRoundParam(round?.id ?? null);
  }, [rounds, round]);

  return (
    <>
      <div className="wrap">
        <header className="app-header">
          <h1>הזמנת בגדים</h1>
          {round && (
            <span className="round-name">
              סבב: <bdi>{round.name}</bdi>
            </span>
          )}
          {round && canSwitchRound && (
            <button type="button" className="btn-secondary btn-sm" onClick={closeRound}>
              החלפת סבב
            </button>
          )}
        </header>
        {showPicker ? (
          <RoundPicker />
        ) : needsLogin ? (
          round && <LoginPanel key={round.id} />
        ) : (
          <>
            <ControlsPanel allowLocalFolder={allowLocalFolder} />
            <OrderNotices />
            <FilterBar />
            <Catalog />
          </>
        )}
      </div>
      {!showPicker && !needsLogin && (
        <>
          <CartFab />
          <SaveIndicator />
        </>
      )}
      <CartModal />
      <RemovedToast />
      <Lightbox />
    </>
  );
}
