import { useEffect } from 'react';
import { CartFab, CartModal } from './components/CartModal';
import { Catalog } from './components/Catalog';
import { ControlsPanel } from './components/ControlsPanel';
import { Lightbox } from './components/Lightbox';
import { DriveNotConfiguredError, loadDriveCatalog } from './lib/source/drive';
import { useOrderStore } from './store/orderStore';

/** The local-folder picker is a development tool; `?local` enables it on a deployed site too. */
const allowLocalFolder = import.meta.env.DEV || new URLSearchParams(window.location.search).has('local');

let initialLoadStarted = false;

async function loadInitialCatalog() {
  if (initialLoadStarted) return;
  initialLoadStarted = true;

  const { loadSource, setStatus } = useOrderStore.getState();
  let notConfigured = false;
  const ok = await loadSource(async () => {
    try {
      return await loadDriveCatalog();
    } catch (err) {
      notConfigured = err instanceof DriveNotConfiguredError;
      throw err;
    }
  });
  if (!ok && notConfigured && allowLocalFolder) setStatus('בחרו תיקייה מקומית (אקסל + תמונות).');
}

export function App() {
  const overlayOpen = useOrderStore((s) => s.cartOpen || s.lightbox !== null);

  useEffect(() => {
    void loadInitialCatalog();
  }, []);

  useEffect(() => {
    document.body.classList.toggle('no-scroll', overlayOpen);
  }, [overlayOpen]);

  return (
    <>
      <div className="wrap">
        <h1>הזמנת בגדים</h1>
        <ControlsPanel allowLocalFolder={allowLocalFolder} />
        <Catalog />
      </div>
      <CartFab />
      <CartModal />
      <Lightbox />
    </>
  );
}
