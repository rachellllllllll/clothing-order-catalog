import type { ShortageLine } from '../../../api/_types';

/** item id + size -> units marked as not arrived. */
export type ShortageIndex = ReadonlyMap<string, number>;

const key = (id: string, size: string) => id + '\n' + size;

export function shortageIndex(lines: readonly ShortageLine[] | undefined): ShortageIndex {
  return new Map((lines ?? []).map((l) => [key(l.id, l.size), l.qty]));
}

/** Units of an ordered line that did not arrive: as marked, but never more than were ordered. */
export function missingQty(index: ShortageIndex, id: string, size: string, ordered: number): number {
  return Math.min(index.get(key(id, size)) ?? 0, ordered);
}
