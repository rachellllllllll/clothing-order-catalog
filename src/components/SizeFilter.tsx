import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { offeredFilterSizes } from '../lib/catalog/selectors';
import { useOrderStore } from '../store/orderStore';

const MARGIN = 8;
const GAP = 6;

/** Fixed-position panel so it is never clipped; opens upwards when there is no room below. */
function positionPanel(btn: HTMLElement, panel: HTMLElement) {
  const btnRect = btn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;

  const width = Math.min(panel.offsetWidth || 360, vw - MARGIN * 2);
  panel.style.width = width + 'px';

  const spaceBelow = vh - btnRect.bottom - GAP - MARGIN;
  const spaceAbove = btnRect.top - GAP - MARGIN;
  const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
  panel.style.maxHeight = Math.max(120, openUp ? spaceAbove : spaceBelow) + 'px';

  const height = panel.offsetHeight;
  let top = openUp ? btnRect.top - GAP - height : btnRect.bottom + GAP;
  top = Math.max(MARGIN, Math.min(top, vh - height - MARGIN));
  let left = btnRect.right - width;
  left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN));

  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}

export function SizeFilter() {
  const catalog = useOrderStore((s) => s.catalog);
  const sizeFilter = useOrderStore((s) => s.sizeFilter);
  const mode = useOrderStore((s) => s.sizeFilterMode);
  const toggleSizeFilter = useOrderStore((s) => s.toggleSizeFilter);
  const setMode = useOrderStore((s) => s.setSizeFilterMode);
  const clearSizeFilter = useOrderStore((s) => s.clearSizeFilter);

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const sizes = useMemo(() => (catalog ? offeredFilterSizes(catalog) : []), [catalog]);

  const reposition = useCallback(() => {
    if (btnRef.current && panelRef.current) positionPanel(btnRef.current, panelRef.current);
  }, []);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  if (!sizes.length) return null;
  const count = sizeFilter.length;

  return (
    <div className="size-filter" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={'size-filter-btn' + (count > 0 ? ' has-active' : '')}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        סינון לפי מידה זמינה
        {count > 0 && <span className="size-filter-badge">{count}</span>}
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="size-filter-panel" ref={panelRef}>
          <div className="size-filter-panel-head">
            <div className="size-filter-mode">
              <button
                type="button"
                className={'mode-opt' + (mode === 'any' ? ' active' : '')}
                onClick={() => setMode('any')}
              >
                זמין באחת מהמידות
              </button>
              <button
                type="button"
                className={'mode-opt' + (mode === 'all' ? ' active' : '')}
                onClick={() => setMode('all')}
              >
                זמין בכל המידות
              </button>
            </div>
            <button type="button" className="btn-link" disabled={count === 0} onClick={clearSizeFilter}>
              נקה הכל
            </button>
          </div>
          <div className="size-filter-pills">
            {sizes.map((s) => (
              <button
                key={s}
                type="button"
                className={'size-pill' + (sizeFilter.includes(s) ? ' active' : '')}
                onClick={() => toggleSizeFilter(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
