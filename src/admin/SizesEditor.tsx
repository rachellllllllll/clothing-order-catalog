import { useState } from 'react';
import { SIZE_PRESETS, sizeLabel } from '../lib/catalog/catalogDoc';

interface SizesEditorProps {
  sizes: string[];
  onChange: (sizes: string[]) => void;
  /** Why a size can't be removed (e.g. it was ordered), or null. */
  lockedReason?: (size: string) => string | null;
}

/** The round's size list: quick sets (adults / babies / kids / numbers), free text, and removable chips. */
export function SizesEditor({ sizes, onChange, lockedReason }: SizesEditorProps) {
  const [text, setText] = useState('');

  const add = (list: string[]) => {
    const out = [...sizes];
    for (const s of list.map(sizeLabel)) if (s && s.length <= 20 && !out.includes(s)) out.push(s);
    onChange(out);
  };
  const remove = (list: string[]) => onChange(sizes.filter((s) => !list.includes(s) || lockedReason?.(s)));

  function addText() {
    add(text.split(','));
    setText('');
  }

  return (
    <div className="sizes-editor">
      <div className="sizes-presets">
        {SIZE_PRESETS.map((p) => {
          const all = p.sizes.every((s) => sizes.includes(s));
          return (
            <button
              key={p.label}
              type="button"
              className="size-preset"
              aria-pressed={all}
              title={all ? 'הסרת המידות האלה' : 'הוספת המידות: ' + p.sizes.join(', ')}
              onClick={() => (all ? remove(p.sizes) : add(p.sizes))}
            >
              {all ? '✓ ' : '+ '}
              {p.label} <span className="muted">({p.sizes[0]}–{p.sizes[p.sizes.length - 1]})</span>
            </button>
          );
        })}
        <span className="sizes-add">
          <input
            type="text"
            value={text}
            placeholder="מידות נוספות, למשל: 36, 38, ONE SIZE"
            aria-label="הוספת מידות"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addText();
              }
            }}
          />
          <button type="button" className="btn-secondary btn-sm" disabled={!text.trim()} onClick={addText}>
            הוספה
          </button>
        </span>
      </div>
      <div className="sizes-chips">
        {sizes.length ? (
          sizes.map((s) => {
            const locked = lockedReason?.(s) ?? null;
            return (
              <span key={s} className="chip size-chip">
                <bdi>{s}</bdi>
                <button
                  type="button"
                  className="chip-x"
                  disabled={!!locked}
                  title={locked ?? 'הסרת המידה ' + s}
                  aria-label={'הסרת המידה ' + s}
                  onClick={() => remove([s])}
                >
                  ×
                </button>
              </span>
            );
          })
        ) : (
          <span className="muted small">עדיין לא נבחרו מידות.</span>
        )}
      </div>
    </div>
  );
}
