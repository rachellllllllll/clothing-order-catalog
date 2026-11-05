import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useZoomPan } from '../hooks/useZoomPan';
import { groupUnits } from '../lib/catalog/selectors';
import type { ModelGroup } from '../lib/catalog/types';
import { useGroupQty, useImage } from '../store/hooks';
import { useOrderStore } from '../store/orderStore';
import { ProductImage } from './ProductImage';
import { VariantPicker } from './VariantPicker';

const STRIP_RADIUS = 3;

export function Lightbox() {
  const lightbox = useOrderStore((s) => s.lightbox);
  const catalog = useOrderStore((s) => s.catalog);
  if (!lightbox || !catalog || !lightbox.models.length) return null;

  const key = lightbox.models[lightbox.index];
  const group = catalog.groups.find((g) => g.key === key);
  if (!group) return null;
  return <LightboxView group={group} models={lightbox.models} index={lightbox.index} groups={catalog.groups} />;
}

function LightboxView({
  group,
  models,
  index,
  groups,
}: {
  group: ModelGroup;
  models: string[];
  index: number;
  groups: ModelGroup[];
}) {
  const stepLightbox = useOrderStore((s) => s.stepLightbox);
  const setLightboxIndex = useOrderStore((s) => s.setLightboxIndex);
  const closeLightbox = useOrderStore((s) => s.closeLightbox);
  const qty = useGroupQty(group);
  const images = useOrderStore((s) => s.source?.images);
  const image = images?.get(group.key);
  const dialogRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const zoom = useZoomPan(wrapRef, imgRef);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const titleId = useId();
  const shownKey = useRef(group.key);
  shownKey.current = group.key;

  const src = image?.full ?? '';
  const showFallback = !src || failedSrc === src;
  const loaded = loadedSrc === src;

  useEffect(() => {
    zoom.reset();
  }, [index, zoom]);

  // Focus moves into the dialog; on close it returns to the card of the model shown last.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      const card = document.querySelector<HTMLElement>(`[data-model-key="${CSS.escape(shownKey.current)}"] .img-wrap`);
      card?.scrollIntoView({ block: 'nearest' });
      (card ?? opener)?.focus({ preventScroll: true });
    };
  }, []);

  // A nav button that disappears at the list's end must not drop the focus out of the dialog.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
  }, [index]);

  // Warm the browser cache for the neighbours, so stepping shows the full image at once.
  useEffect(() => {
    for (const i of [index + 1, index - 1]) {
      const key = models[i];
      const next = key ? images?.get(key)?.full : undefined;
      if (!next) continue;
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.src = next;
    }
  }, [index, models, images]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      switch (e.key) {
        case 'Escape':
          if (zoom.isZoomed()) zoom.reset();
          else closeLightbox();
          break;
        case '+':
        case '=':
          zoom.zoomAtCenter(1.3);
          break;
        case '-':
          zoom.zoomAtCenter(1 / 1.3);
          break;
        case '0':
          zoom.reset();
          break;
        // RTL: the left arrow points "forward".
        case 'ArrowLeft':
          if (!zoom.isZoomed()) stepLightbox(1);
          break;
        case 'ArrowRight':
          if (!zoom.isZoomed()) stepLightbox(-1);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [zoom, closeLightbox, stepLightbox]);

  // Keep Tab inside the dialog (aria-modal): wrap around at both ends.
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]'),
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (e.shiftKey && (current === first || current === e.currentTarget)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && current === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const multi = models.length > 1;
  const from = Math.max(0, index - STRIP_RADIUS);
  const to = Math.min(models.length, index + STRIP_RADIUS + 1);
  const stripKeys = multi ? models.slice(from, to) : [];

  return (
    <div
      ref={dialogRef}
      className="lightbox-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={trapTab}
      onClick={(e) => e.target === e.currentTarget && closeLightbox()}
    >
      <button type="button" className="lightbox-close" aria-label="סגירה" onClick={closeLightbox}>
        ✕
      </button>
      <div className="lightbox-stage">
        <div className="lightbox-image-wrap" ref={wrapRef}>
          {index > 0 && (
            <button type="button" className="lightbox-nav lightbox-prev" aria-label="הקודם" onClick={() => stepLightbox(-1)} />
          )}
          {!showFallback && !loaded && image?.thumb && (
            <img className="lightbox-placeholder" src={image.thumb} alt="" aria-hidden="true" referrerPolicy="no-referrer" />
          )}
          <img
            ref={imgRef}
            className={loaded ? undefined : 'loading'}
            src={src || undefined}
            alt={group.model}
            referrerPolicy="no-referrer"
            style={showFallback ? { display: 'none' } : undefined}
            onLoad={() => setLoadedSrc(src)}
            onError={() => setFailedSrc(src)}
          />
          {showFallback && <div className="lightbox-image-fallback">לא נמצאה תמונה לדגם זה</div>}
          {!showFallback && <div className="lightbox-zoom-hint">גלגלת להגדלה · גרירה להזזה · דאבל-קליק לאיפוס</div>}
          {!showFallback && (
            <div className="lightbox-zoom">
              <button type="button" aria-label="הגדלה" title="הגדלה (+)" onClick={() => zoom.zoomAtCenter(1.3)}>
                +
              </button>
              <button
                type="button"
                className="zoom-when-zoomed"
                aria-label="הקטנה"
                title="הקטנה (-)"
                onClick={() => zoom.zoomAtCenter(1 / 1.3)}
              >
                −
              </button>
              <button type="button" className="zoom-when-zoomed" aria-label="גודל מקורי" title="גודל מקורי (0)" onClick={zoom.reset}>
                ⤢
              </button>
            </div>
          )}
          {index < models.length - 1 && (
            <button type="button" className="lightbox-nav lightbox-next" aria-label="הבא" onClick={() => stepLightbox(1)} />
          )}
        </div>
        <div className="lightbox-actions">
          <div className="lightbox-title">
            <strong className="model-name" id={titleId}>
              {group.model}
            </strong>
            {multi && (
              <span className="lightbox-counter" dir="ltr" aria-label={`דגם ${index + 1} מתוך ${models.length}`}>
                {index + 1} / {models.length}
              </span>
            )}
          </div>
          <VariantPicker group={group} qty={qty} />
        </div>
        {multi && (
          <div className="lightbox-strip">
            {stripKeys.map((k, i) => {
              const g = groups.find((x) => x.key === k);
              return (
                g && (
                  <StripThumb
                    key={k}
                    group={g}
                    active={from + i === index}
                    onClick={() => setLightboxIndex(from + i)}
                  />
                )
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StripThumb({ group, active, onClick }: { group: ModelGroup; active: boolean; onClick: () => void }) {
  const image = useImage(group.key);
  const units = groupUnits(useGroupQty(group), group);
  const label = units > 0 ? `${group.model} — הוזמן (${units})` : group.model;
  return (
    <button
      type="button"
      className={'lightbox-thumb' + (active ? ' active' : '') + (units > 0 ? ' ordered' : '')}
      title={label}
      aria-label={label}
      aria-current={active || undefined}
      onClick={onClick}
    >
      <ProductImage src={image?.thumb} alt={group.model} placeholder="" placeholderClassName="tiny-placeholder" />
      {units > 0 && <span className="lightbox-thumb-badge">✓ {units}</span>}
    </button>
  );
}
