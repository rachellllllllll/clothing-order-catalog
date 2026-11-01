import { useEffect, useState } from 'react';
import { CartFab, CartModal, RemovedToast, SaveIndicator } from './components/CartModal';
import { Catalog } from './components/Catalog';
import { ControlsPanel } from './components/ControlsPanel';
import { FilterBar } from './components/FilterBar';
import { Lightbox } from './components/Lightbox';
import { LoginPanel, OrderOpening } from './components/LoginPanel';
import { OrderNotices } from './components/OrderNotices';
import { RoundPicker } from './components/RoundPicker';
import { apiPost } from './lib/api/client';
import { DriveNotConfiguredError, loadDriveCatalog } from './lib/source/drive';
import type { Round } from './lib/source/types';
import { useOrderStore } from './store/orderStore';
import { logout } from './store/orderSync';

const params = new URLSearchParams(window.location.search);

/** `?round=<id>` keeps the chosen round across reloads and bookmarks. */
const initialRoundId = params.get('round');

/** `?round=<id>&preview` (from the admin page): the round as orderers see it, drafts included. Nothing is saved. */
const preview = params.has('preview') && !!initialRoundId;

/** The local-folder picker is a development tool; `?local` enables it on a deployed site too. */
const allowLocalFolder = !preview && (import.meta.env.DEV || params.has('local'));

function setRoundParam(roundId: string | null) {
  const url = new URL(window.location.href);
  if (roundId) url.searchParams.set('round', roundId);
  else url.searchParams.delete('round');
  window.history.replaceState(null, '', url);
}

let initialLoadStarted = false;

/** Loads the rounds (and opens the wanted one) behind the sign-in screen. True when only a local folder can be used. */
async function loadInitialCatalog(): Promise<boolean> {
  if (initialLoadStarted) return false;
  initialLoadStarted = true;

  const { loadRounds, openRound, setStatus } = useOrderStore.getState();
  if (preview) {
    try {
      await openPreview();
    } catch (err) {
      setStatus('התצוגה המקדימה נכשלה: ' + (err instanceof Error ? err.message : String(err)), true);
    }
    return false;
  }
  try {
    const rounds = await loadRounds();
    if (!rounds.length) {
      setStatus('לא נמצאו סבבי הזמנה בתיקיית הדרייב.', true);
      return false;
    }
    const active = rounds.filter((r) => !r.archived);
    const wanted = rounds.find((r) => r.id === initialRoundId) ?? (active.length === 1 && rounds.length === 1 ? active[0] : null);
    if (wanted) await openRound(wanted);
  } catch (err) {
    console.error(err);
    if (err instanceof DriveNotConfiguredError && allowLocalFolder) {
      setStatus('בחרו תיקייה מקומית (אקסל + תמונות).');
      return true;
    }
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
  return false;
}

/** Needs the admin session; the member signed in on this device (if any) is ignored, so no order is opened. */
/** The preview opens in its own tab: close it to reveal the admin tab, or go there if the browser keeps it open. */
function backToEditor() {
  window.close();
  setTimeout(() => location.assign('/admin?round=' + encodeURIComponent(initialRoundId ?? '')), 100);
}

async function openPreview() {
  const { rounds } = await apiPost<{ rounds: Round[] }>('/api/admin', { action: 'rounds' });
  const round = rounds.find((r) => r.id === initialRoundId);
  if (!round) throw new Error('הסבב לא נמצא.');
  useOrderStore.setState({ member: null, rounds: [round] });
  if (await useOrderStore.getState().loadSource(() => loadDriveCatalog(round, { admin: true }))) {
    useOrderStore.setState({ round });
  }
}

export function App() {
  const [localOnly, setLocalOnly] = useState(false);
  const overlayOpen = useOrderStore((s) => s.cartOpen || s.lightbox !== null);
  const rounds = useOrderStore((s) => s.rounds);
  const round = useOrderStore((s) => s.round);
  const hasCatalog = useOrderStore((s) => !!s.catalog);
  const member = useOrderStore((s) => s.member);
  const isLocal = useOrderStore((s) => s.source?.kind === 'local');
  const needsOrder = useOrderStore((s) => s.source?.kind === 'drive' && !s.account) && !preview;
  const closeRound = useOrderStore((s) => s.closeRound);
  const canSwitchRound = !preview && ((rounds?.length ?? 0) > 1 || !!rounds?.[0]?.archived);
  // Drive rounds are shown only after signing in; a local folder (development) needs no sign-in.
  const needsSignIn = !member && !isLocal && !localOnly && !preview;
  const showPicker = !needsSignIn && canSwitchRound && !hasCatalog;
  const showCatalog = !needsSignIn && !showPicker && !needsOrder;

  useEffect(() => {
    void loadInitialCatalog().then((local) => local && setLocalOnly(true));
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
          {round && !needsSignIn && (
            <span className="round-name">
              סבב: <bdi>{round.name}</bdi>
            </span>
          )}
          {round && !needsSignIn && canSwitchRound && (
            <button type="button" className="btn-secondary btn-sm" onClick={closeRound}>
              החלפת סבב
            </button>
          )}
          {member && !isLocal && (
            <span className="header-account">
              <bdi>{member.name}</bdi>
              <button type="button" className="btn-secondary btn-sm" onClick={() => void logout()}>
                יציאה
              </button>
            </span>
          )}
        </header>
        {preview && (
          <div className="status preview-banner">
            <span>תצוגה מקדימה של מנהל — כך המזמינים יראו את הקטלוג. שום דבר כאן לא נשמר.</span>
            <button type="button" className="btn-secondary btn-sm" onClick={backToEditor}>
              ← חזרה לעריכת הסבב
            </button>
          </div>
        )}
        {needsSignIn ? (
          <LoginPanel />
        ) : showPicker ? (
          <RoundPicker />
        ) : needsOrder ? (
          round && <OrderOpening key={round.id} onBack={canSwitchRound ? closeRound : undefined} />
        ) : (
          <>
            <ControlsPanel allowLocalFolder={allowLocalFolder} />
            <OrderNotices />
            <FilterBar />
            <Catalog />
          </>
        )}
      </div>
      {showCatalog && (
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
