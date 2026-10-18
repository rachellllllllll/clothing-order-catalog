import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';

const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const HINT_KEY = 'orderUi:zoomHintSeen';
const HINT_INTRO_MS = 3200;

type HintMode = 'intro' | 'hover' | 'disabled';

function hintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

function markHintSeen(): void {
  try {
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    // Ignore storage errors in restricted environments.
  }
}

export interface ZoomPan {
  reset(): void;
  zoomAtCenter(factor: number): void;
  isZoomed(): boolean;
}

/**
 * Wheel to zoom (around the cursor), drag to pan, double-click to reset.
 * The transform and the wrapper state classes ("zoomed", "dragging", "hint-*") are applied
 * imperatively so zooming never re-renders React; the wrapper's className prop must stay constant.
 */
export function useZoomPan(
  wrapRef: RefObject<HTMLElement | null>,
  imgRef: RefObject<HTMLImageElement | null>,
): ZoomPan {
  const z = useRef({ scale: 1, tx: 0, ty: 0, dragging: false, startX: 0, startY: 0, startTx: 0, startTy: 0 });
  const hint = useRef<{ dismissed: boolean; timer: number; firstTime: boolean | null }>({
    dismissed: false,
    timer: 0,
    firstTime: null,
  });
  if (hint.current.firstTime === null) hint.current.firstTime = !hintSeen();

  const setHint = useCallback(
    (mode: HintMode) => {
      const w = wrapRef.current;
      if (!w) return;
      w.classList.remove('hint-intro', 'hint-hover', 'hint-disabled');
      w.classList.add('hint-' + mode);
    },
    [wrapRef],
  );

  const markInteracted = useCallback(() => {
    if (hint.current.dismissed) return;
    hint.current.dismissed = true;
    clearTimeout(hint.current.timer);
    setHint('disabled');
    markHintSeen();
  }, [setHint]);

  const api = useMemo(() => {
    const s = z.current;
    const isZoomed = () => s.scale > 1.001;

    const apply = () => {
      const img = imgRef.current;
      if (!img) return;
      img.style.transform = `translate(${s.tx}px, ${s.ty}px) scale(${s.scale})`;
      wrapRef.current?.classList.toggle('zoomed', isZoomed());
    };

    // Keep the image covering the viewport when larger than it, centered when smaller.
    const clamp = () => {
      const img = imgRef.current;
      const wrap = wrapRef.current;
      if (!img || !wrap) return;
      const rect = img.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const baseLeft = rect.left - s.tx;
      const baseTop = rect.top - s.ty;

      if (rect.width <= wrapRect.width) {
        s.tx = wrapRect.left + (wrapRect.width - rect.width) / 2 - baseLeft;
      } else {
        const minTx = wrapRect.right - rect.width - baseLeft;
        const maxTx = wrapRect.left - baseLeft;
        s.tx = Math.min(maxTx, Math.max(minTx, s.tx));
      }
      if (rect.height <= wrapRect.height) {
        s.ty = wrapRect.top + (wrapRect.height - rect.height) / 2 - baseTop;
      } else {
        const minTy = wrapRect.bottom - rect.height - baseTop;
        const maxTy = wrapRect.top - baseTop;
        s.ty = Math.min(maxTy, Math.max(minTy, s.ty));
      }
    };

    const commit = () => {
      apply();
      clamp();
      apply();
    };

    const reset = () => {
      s.scale = 1;
      s.tx = 0;
      s.ty = 0;
      s.dragging = false;
      wrapRef.current?.classList.remove('dragging');
      apply();
    };

    const zoomAt = (clientX: number, clientY: number, factor: number) => {
      const img = imgRef.current;
      if (!img) return;
      const newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s.scale * factor));
      if (Math.abs(newScale - s.scale) < 0.0001) return;
      const rect = img.getBoundingClientRect();
      if (!rect.width) return;
      // Keep the point under the cursor fixed while scaling.
      s.tx += (clientX - rect.left) * (1 - newScale / s.scale);
      s.ty += (clientY - rect.top) * (1 - newScale / s.scale);
      s.scale = newScale;
      markInteracted();
      commit();
    };

    const zoomAtCenter = (factor: number) => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    };

    return { isZoomed, commit, reset, zoomAt, zoomAtCenter };
  }, [imgRef, wrapRef, markInteracted]);

  // Pointer listeners (wheel must be non-passive to prevent page scroll).
  useEffect(() => {
    const wrap = wrapRef.current;
    const img = imgRef.current;
    if (!wrap || !img) return;
    const s = z.current;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      api.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || !api.isZoomed()) return;
      e.preventDefault();
      markInteracted();
      Object.assign(s, { dragging: true, startX: e.clientX, startY: e.clientY, startTx: s.tx, startTy: s.ty });
      wrap.classList.add('dragging');
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!s.dragging) return;
      s.tx = s.startTx + (e.clientX - s.startX);
      s.ty = s.startTy + (e.clientY - s.startY);
      api.commit();
    };
    const onMouseUp = () => {
      if (!s.dragging) return;
      s.dragging = false;
      wrap.classList.remove('dragging');
    };
    const onDblClick = (e: MouseEvent) => {
      e.preventDefault();
      markInteracted();
      api.reset();
    };
    const onDragStart = (e: DragEvent) => e.preventDefault();

    wrap.addEventListener('wheel', onWheel, { passive: false });
    wrap.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    img.addEventListener('dblclick', onDblClick);
    img.addEventListener('dragstart', onDragStart);
    return () => {
      wrap.removeEventListener('wheel', onWheel);
      wrap.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      img.removeEventListener('dblclick', onDblClick);
      img.removeEventListener('dragstart', onDragStart);
    };
  }, [api, imgRef, wrapRef, markInteracted]);

  // Zoom hint: shown once on the very first open, afterwards only on hover, never after the user zoomed.
  useEffect(() => {
    const h = hint.current;
    if (h.dismissed) {
      setHint('disabled');
      return;
    }
    if (!h.firstTime) {
      setHint('hover');
      return;
    }
    markHintSeen();
    setHint('intro');
    h.timer = window.setTimeout(() => {
      if (!h.dismissed) setHint('hover');
    }, HINT_INTRO_MS);
    return () => clearTimeout(h.timer);
  }, [setHint]);

  return useMemo(
    () => ({ reset: api.reset, zoomAtCenter: api.zoomAtCenter, isZoomed: api.isZoomed }),
    [api],
  );
}
