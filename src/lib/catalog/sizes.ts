import { normalizeHeader } from './text';
import type { SizeColumn } from './types';

const LETTER_SIZES = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', '2xl', '3xl', 'xxxl'];

export function isSizeHeader(v: unknown): boolean {
  const t = normalizeHeader(v).replace(/\./g, '');
  if (LETTER_SIZES.includes(t)) return true;
  if (/^\d{1,2}m$/.test(t)) return true; // baby sizes in months: 3m, 24m
  if (/^\d{1,2}y$/.test(t)) return true; // kids sizes in years: 2y, 16y
  if (/^\d{1,2}$/.test(t)) return true; // plain numeric: 2, 10, 22
  return false;
}

/**
 * Converts a size token to a comparable scale (months).
 * Plain numbers and "..Y" are years; "..M" are months.
 * Month sizes rank just below the numerically-equal year size (24M < 2Y),
 * so a "2Y-16Y" range does not include the 24M column.
 */
export function sizeToMonths(token: unknown): number | null {
  const t = String(token ?? '').trim().toUpperCase();
  let m = /^(\d+)\s*M$/.exec(t);
  if (m) return parseInt(m[1], 10) - 0.5;
  m = /^(\d+)\s*Y$/.exec(t);
  if (m) return parseInt(m[1], 10) * 12;
  m = /^(\d+)$/.exec(t);
  if (m) return parseInt(m[1], 10) * 12;
  return null;
}

/** Parses an availability range like "10Y-22Y", "18M-10Y", "2Y-16Y". */
export function parseSizeRange(rangeText: string): { lo: number; hi: number } | null {
  if (!rangeText) return null;
  const parts = rangeText.split(/\s*[-–—]\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const lo = sizeToMonths(parts[0]);
  const hi = sizeToMonths(parts[parts.length - 1]);
  if (lo == null || hi == null) return null;
  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
}

/** Returns the set of size labels available for the range, or null when all sizes are available. */
export function computeAvailableSizes(rangeText: string, sizeCols: SizeColumn[]): Set<string> | null {
  const range = parseSizeRange(rangeText);
  if (!range) return null;
  const set = new Set<string>();
  for (const s of sizeCols) {
    const months = sizeToMonths(s.label);
    if (months == null || (months >= range.lo && months <= range.hi)) set.add(s.label);
  }
  return set;
}
