import { useEffect, useRef, useState } from 'react';
import { useZoomPan } from '../hooks/useZoomPan';

/** A single product image, large, with the order page's lightbox zoom (wheel, drag, double-click, +/-/0). */
export function ImageView({ src, caption, onClose }: { src: string; caption: string; onClose: () => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const zoom = useZoomPan(wrapRef, imgRef);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          if (zoom.isZoomed()) zoom.reset();
          else onClose();
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
        default:
          return;
      }
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [zoom, onClose]);

  return (
    <div className="lightbox-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <button type="button" className="lightbox-close" aria-label="סגירה" onClick={onClose}>
        ✕
      </button>
      <div className="lightbox-stage admin-image-stage" role="dialog" aria-label={caption}>
        <div className="lightbox-image-wrap" ref={wrapRef}>
          <img
            ref={imgRef}
            src={src}
            alt={caption}
            referrerPolicy="no-referrer"
            style={failed ? { display: 'none' } : undefined}
            onError={() => setFailed(true)}
          />
          {failed ? (
            <div className="lightbox-image-fallback">לא ניתן לטעון את התמונה</div>
          ) : (
            <div className="lightbox-zoom-hint">גלגלת להגדלה · גרירה להזזה · דאבל-קליק לאיפוס</div>
          )}
        </div>
        <div className="lightbox-actions">
          <bdi className="model-name">{caption}</bdi>
        </div>
      </div>
    </div>
  );
}
