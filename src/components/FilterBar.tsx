import type { SortMode } from '../lib/catalog/types';
import { useVisibleGroups } from '../store/hooks';
import { useOrderStore } from '../store/orderStore';
import { SizeFilter } from './SizeFilter';

export function FilterBar() {
  const total = useOrderStore((s) => s.catalog?.groups.length ?? 0);
  const search = useOrderStore((s) => s.search);
  const sort = useOrderStore((s) => s.sort);
  const filterActive = useOrderStore((s) => s.search.trim() !== '' || s.sizeFilter.length > 0);
  const setSearch = useOrderStore((s) => s.setSearch);
  const setSort = useOrderStore((s) => s.setSort);
  const shown = useVisibleGroups().length;

  return (
    <div className="filter-bar">
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
      {filterActive && (
        <span className="result-count">
          מציג {shown} מתוך {total} דגמים
        </span>
      )}
    </div>
  );
}
