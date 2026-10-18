import { useVisibleGroups } from '../store/hooks';
import { useOrderStore } from '../store/orderStore';
import { ProductCard } from './ProductCard';

export function Catalog() {
  const hasCatalog = useOrderStore((s) => !!s.catalog?.groups.length);
  const groups = useVisibleGroups();

  if (!hasCatalog) return null;

  return (
    <section className="panel catalog">
      {groups.length ? (
        groups.map((g) => <ProductCard key={g.key} group={g} />)
      ) : (
        <div className="muted catalog-empty">לא נמצאו פריטים התואמים לחיפוש או לסינון.</div>
      )}
    </section>
  );
}
