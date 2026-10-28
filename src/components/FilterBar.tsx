import { toMoney } from '../lib/catalog/text';
import type { SortMode } from '../lib/catalog/types';
import { useCart } from '../store/cartHooks';
import { useVisibleGroups } from '../store/hooks';
import { useOrderStore } from '../store/orderStore';
import { SizeFilter } from './SizeFilter';

/** Sticky top bar: search / sort / filters + a compact cart summary that stays visible while scrolling. */
export function FilterBar() {
  const total = useOrderStore((s) => s.catalog?.groups.length ?? 0);
  const search = useOrderStore((s) => s.search);
  const sort = useOrderStore((s) => s.sort);
  const onlyOrdered = useOrderStore((s) => s.onlyOrdered);
  const filterActive = useOrderStore((s) => s.search.trim() !== '' || s.sizeFilter.length > 0 || s.onlyOrdered);
  const setSearch = useOrderStore((s) => s.setSearch);
  const setSort = useOrderStore((s) => s.setSort);
  const setOnlyOrdered = useOrderStore((s) => s.setOnlyOrdered);
  const setCartOpen = useOrderStore((s) => s.setCartOpen);
  const { totals } = useCart();
  const shown = useVisibleGroups().length;

  if (total === 0) return null;

  return (
    <div className="panel filter-bar">
      <input
        type="text"
        placeholder="חיפוש לפי שם דגם או צבע…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
        <option value="default">מיון: ברירת מחדל</option>
        <option value="name">מיון: שם א–ת</option>
        <option value="price-asc">מיון: מחיר עולה</option>
        <option value="price-desc">מיון: מחיר יורד</option>
        <option value="ordered">מיון: הוזמן ראשון</option>
      </select>
      <SizeFilter />
      <label className={'only-ordered' + (onlyOrdered ? ' active' : '')}>
        <input type="checkbox" checked={onlyOrdered} onChange={(e) => setOnlyOrdered(e.target.checked)} />
        הצג רק מה שהוזמן
      </label>
      <div className="filter-bar-end">
        {filterActive && (
          <span className="result-count">
            מציג {shown} מתוך {total} דגמים
          </span>
        )}
        <button type="button" className="topbar-cart" title="פתיחת הסל" onClick={() => setCartOpen(true)}>
          🛒 {totals.units} יחידות | {toMoney(totals.amount)}
        </button>
      </div>
    </div>
  );
}
