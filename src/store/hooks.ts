import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { filterGroups } from '../lib/catalog/selectors';
import type { ModelGroup, QtyMap } from '../lib/catalog/types';
import type { ImageRef } from '../lib/source/types';
import { useOrderStore } from './orderStore';

/** Quantities for a single model only — components re-render only when their own model changes. */
export function useGroupQty(group: ModelGroup): QtyMap {
  const slices = useOrderStore(useShallow((s) => group.variants.map((v) => s.qty[v.id])));
  return useMemo(() => {
    const m: QtyMap = {};
    group.variants.forEach((v, i) => {
      if (slices[i]) m[v.id] = slices[i];
    });
    return m;
  }, [group, slices]);
}

export function useImage(modelKey: string): ImageRef | undefined {
  return useOrderStore((s) => s.source?.images.get(modelKey));
}

export function useVisibleGroups(): ModelGroup[] {
  const { catalog, qty, search, sort, sizeFilter, sizeFilterMode, onlyOrdered } = useOrderStore(
    useShallow((s) => ({
      catalog: s.catalog,
      qty: s.qty,
      search: s.search,
      sort: s.sort,
      sizeFilter: s.sizeFilter,
      sizeFilterMode: s.sizeFilterMode,
      onlyOrdered: s.onlyOrdered,
    })),
  );
  return useMemo(
    () =>
      catalog ? filterGroups(catalog.groups, qty, { search, sort, sizeFilter, sizeFilterMode, onlyOrdered }) : [],
    [catalog, qty, search, sort, sizeFilter, sizeFilterMode, onlyOrdered],
  );
}
