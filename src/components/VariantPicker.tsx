import { useState } from 'react';
import { activeVariantIndex, isSizeAvailable, qtyOf, variantUnits } from '../lib/catalog/selectors';
import { toMoney } from '../lib/catalog/text';
import type { CatalogItem, ModelGroup, QtyMap, SizeColumn } from '../lib/catalog/types';
import { isReadOnly, useOrderStore } from '../store/orderStore';

const NO_SIZES: SizeColumn[] = [];

interface Props {
  group: ModelGroup;
  qty: QtyMap;
}

/** Color tabs (when the model has several colors) + the size counters of the active color. */
export function VariantPicker({ group, qty }: Props) {
  const saved = useOrderStore((s) => s.activeColorByModel[group.key]);
  const setActiveColor = useOrderStore((s) => s.setActiveColor);
  const active = activeVariantIndex(group, qty, saved);
  const multiColor = group.variants.length > 1;

  return (
    <>
      {multiColor && (
        <div className="color-tabs">
          {group.variants.map((v, i) => {
            const units = variantUnits(qty, v);
            return (
              <button
                key={v.id}
                type="button"
                className={'color-tab' + (i === active ? ' active' : '') + (units > 0 ? ' tab-has-qty' : '')}
                onClick={() => setActiveColor(group.key, i)}
              >
                {v.color || 'ללא צבע'}
                {units > 0 && <span className="tab-qty">{units}</span>}
              </button>
            );
          })}
        </div>
      )}
      <VariantPanel item={group.variants[active]} qty={qty} showColor={!multiColor} />
    </>
  );
}

function VariantPanel({ item, qty, showColor }: { item: CatalogItem; qty: QtyMap; showColor: boolean }) {
  const sizeCols = useOrderStore((s) => s.catalog?.columns.sizeCols ?? NO_SIZES);
  const changeQty = useOrderStore((s) => s.changeQty);
  const setQty = useOrderStore((s) => s.setQty);
  const readOnly = useOrderStore(isReadOnly);

  return (
    <div className="variant">
      <div className="variant-head">
        <div className="chips">
          {showColor && <span className="chip">{item.color || 'ללא צבע'}</span>}
          {item.price == null && <span className="chip chip-warn">ללא מחיר</span>}
          {item.notes && <span className="chip">{item.notes}</span>}
          {item.sizeRange && <span className="chip chip-size">מידות: {item.sizeRange}</span>}
        </div>
        <strong>{toMoney(item.price)}</strong>
      </div>
      <div className="sizes">
        {sizeCols.map(({ label }) => {
          const q = qtyOf(qty, item.id, label);
          const available = isSizeAvailable(item, label);
          if (!available && q <= 0) return null;
          return (
            <div
              key={label}
              className={'size-box' + (q > 0 ? ' size-has-qty' : '') + (!available ? ' size-unavailable' : '')}
            >
              <div className="label">{label}</div>
              <div className="counter">
                <button
                  type="button"
                  aria-label={`הפחת ${label}`}
                  disabled={readOnly}
                  onClick={() => changeQty(item.id, label, -1)}
                >
                  -
                </button>
                <QtyInput label={label} value={q} readOnly={readOnly} onChange={(n) => setQty(item.id, label, n)} />
                <button
                  type="button"
                  aria-label={`הוסף ${label}`}
                  disabled={readOnly}
                  onClick={() => changeQty(item.id, label, 1)}
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Quantity field that accepts typed digits; an empty field counts as 0 and shows the stored value on blur. */
function QtyInput({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  value: number;
  readOnly: boolean;
  onChange: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <input
      className="qty"
      type="text"
      inputMode="numeric"
      aria-label={`כמות ${label}`}
      readOnly={readOnly}
      value={draft ?? String(value)}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
        setDraft(digits);
        onChange(digits === '' ? 0 : Number(digits));
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}
