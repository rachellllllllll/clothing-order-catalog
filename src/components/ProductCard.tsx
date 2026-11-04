import { memo } from 'react';
import { groupUnits } from '../lib/catalog/selectors';
import type { ModelGroup } from '../lib/catalog/types';
import { useGroupQty, useImage } from '../store/hooks';
import { useOrderStore } from '../store/orderStore';
import { ProductImage } from './ProductImage';
import { VariantPicker } from './VariantPicker';

export const ProductCard = memo(function ProductCard({ group }: { group: ModelGroup }) {
  const qty = useGroupQty(group);
  const image = useImage(group.key);
  const openLightbox = useOrderStore((s) => s.openLightbox);
  const total = groupUnits(qty, group);

  // The whole card opens the product view (quantities are picked there); a color tab opens it in that color.
  return (
    <article
      className={'card' + (total > 0 ? ' card-ordered' : '')}
      data-model-key={group.key}
      onClick={() => openLightbox(group.key)}
    >
      <button type="button" className="img-wrap" title="פתיחת המוצר">
        <ProductImage src={image?.thumb} alt={group.model} />
        {total > 0 && <div className="card-ordered-badge">✓ הוזמן ({total})</div>}
      </button>
      <div className="card-body">
        <div className="model-name">{group.model}</div>
        <VariantPicker group={group} qty={qty} summary />
      </div>
    </article>
  );
});
