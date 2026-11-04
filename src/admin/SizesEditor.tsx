import { useState } from 'react';
import { MAX_SIZE_LENGTH, SIZE_PRESETS, sizeLabel, sortSizes } from '../lib/catalog/catalogDoc';

interface SizesEditorProps {
  sizes: string[];
  onChange: (sizes: string[]) => void;
  /** Why a size can't be removed (e.g. it was ordered), or null. */
  lockedReason?: (size: string) => string | null;
}

/** The round's size list (kept in the usual order): quick sets (adults / babies / kids / numbers), free text, and removable chips. */
export function SizesEditor({ sizes, onChange, lockedReason }: SizesEditorProps) {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');

  const add = (list: string[]) => {
    const out = [...sizes];
    for (const s of list) if (!out.includes(s)) out.push(s);
    onChange(sortSizes(out));
  };
  const remove = (list: string[]) => onChange(sizes.filter((s) => !list.includes(s) || lockedReason?.(s)));

  /** Adds the comma-separated sizes; too long ones stay in the field to be fixed. */
  function addText() {
    const parts = text.split(',').filter((s) => sizeLabel(s));
    const tooLong = parts.filter((s) => sizeLabel(s).length > MAX_SIZE_LENGTH);
    const ok = parts.filter((s) => !tooLong.includes(s)).map(sizeLabel);
    const existing = ok.filter((s) => sizes.includes(s));
    add(ok);
    setText(tooLong.map((s) => s.trim()).join(', '));
    setNote(
      [
        tooLong.length && `מידה יכולה להיות עד ${MAX_SIZE_LENGTH} תווים — קצרו אותה בשדה.`,
        existing.length && `כבר קיימות: ${existing.join(', ')}.`,
      ]
        .filter(Boolean)
        .join(' '),
    );
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
            onChange={(e) => {
              setText(e.target.value);
              setNote('');
            }}
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
      {note && <div className="small warn-text">{note}</div>}
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
