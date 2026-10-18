import { activeVariantIndex, isSizeAvailable, qtyOf, variantUnits } from '../lib/catalog/selectors';
import { toMoney } from '../lib/catalog/text';
import type { CatalogItem, ModelGroup, QtyMap, SizeColumn } from '../lib/catalog/types';
import { useOrderStore } from '../store/orderStore';

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
          {group.variants.map((v, i) => (
            <button
              key={v.id}
              type="button"
              className={
                'color-tab' + (i === active ? ' active' : '') + (variantUnits(qty, v) > 0 ? ' tab-has-qty' : '')
              }
              onClick={() => setActiveColor(group.key, i)}
            >
              {v.color || 'ללא צבע'}
            </button>
          ))}
        </div>
      )}
      <VariantPanel item={group.variants[active]} qty={qty} showColor={!multiColor} />
    </>
  );
}

function VariantPanel({ item, qty, showColor }: { item: CatalogItem; qty: QtyMap; showColor: boolean }) {
  const sizeCols = useOrderStore((s) => s.catalog?.columns.sizeCols ?? NO_SIZES);
  const changeQty = useOrderStore((s) => s.changeQty);

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
                <button type="button" aria-label={`הפחת ${label}`} onClick={() => changeQty(item.id, label, -1)}>
                  -
                </button>
                <span className="qty">{q}</span>
                <button type="button" aria-label={`הוסף ${label}`} onClick={() => changeQty(item.id, label, 1)}>
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
