import { useEffect, useRef, useState } from 'react';
import { useZoomPan } from '../hooks/useZoomPan';
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
  const image = useImage(group.key);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const zoom = useZoomPan(wrapRef, imgRef);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const src = image?.full ?? '';
  const showFallback = !src || failedSrc === src;

  useEffect(() => {
    zoom.reset();
  }, [index, zoom]);

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

  const multi = models.length > 1;
  const from = Math.max(0, index - STRIP_RADIUS);
  const to = Math.min(models.length, index + STRIP_RADIUS + 1);
  const stripKeys = multi ? models.slice(from, to) : [];

  return (
    <div className="lightbox-overlay" onClick={(e) => e.target === e.currentTarget && closeLightbox()}>
      <button type="button" className="lightbox-close" aria-label="סגירה" onClick={closeLightbox}>
        ✕
      </button>
      <div className="lightbox-stage">
        <div className="lightbox-image-wrap" ref={wrapRef}>
          {multi && (
            <button type="button" className="lightbox-nav lightbox-prev" aria-label="הקודם" onClick={() => stepLightbox(-1)} />
          )}
          <img
            ref={imgRef}
            src={src || undefined}
            alt={group.model}
            referrerPolicy="no-referrer"
            style={showFallback ? { display: 'none' } : undefined}
            onError={() => setFailedSrc(src)}
          />
          {showFallback && <div className="lightbox-image-fallback">לא נמצאה תמונה לדגם זה</div>}
          {!showFallback && <div className="lightbox-zoom-hint">גלגלת להגדלה · גרירה להזזה · דאבל-קליק לאיפוס</div>}
          {multi && (
            <button type="button" className="lightbox-nav lightbox-next" aria-label="הבא" onClick={() => stepLightbox(1)} />
          )}
        </div>
        <div className="lightbox-actions">
          <strong className="model-name">{group.model}</strong>
          <VariantPicker group={group} qty={qty} />
        </div>
        {multi && (
          <div className="lightbox-strip">
            {stripKeys.map((k, i) => (
              <StripThumb
                key={k}
                group={groups.find((g) => g.key === k)}
                active={from + i === index}
                onClick={() => setLightboxIndex(from + i)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StripThumb({ group, active, onClick }: { group?: ModelGroup; active: boolean; onClick: () => void }) {
  const image = useImage(group?.key ?? '');
  if (!group) return null;
  return (
    <button type="button" className={'lightbox-thumb' + (active ? ' active' : '')} title={group.model} onClick={onClick}>
      <ProductImage src={image?.thumb} alt={group.model} placeholder="" placeholderClassName="tiny-placeholder" />
    </button>
  );
}
