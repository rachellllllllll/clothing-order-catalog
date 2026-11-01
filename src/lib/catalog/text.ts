export function safeText(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/** Lowercase, strip whitespace and punctuation — used to match models, colors and image file names. */
export function normalizeText(v: unknown): string {
  return safeText(v)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function normalizeHeader(v: unknown): string {
  return safeText(v).toLowerCase().replace(/\s+/g, ' ');
}

export function toMoney(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return 'ללא מחיר';
  return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Units that did not arrive from the supplier, singular-aware: "יחידה אחת לא הגיעה" / "3 יח׳ לא הגיעו". */
export function notArrived(n: number): string {
  return n === 1 ? 'יחידה אחת לא הגיעה' : `${n} יח׳ לא הגיעו`;
}

/** A change in units with its sign: "+2" / "−1", isolated left-to-right so the sign stays in front in Hebrew text. */
export const signed = (n: number) => '\u2066' + (n > 0 ? '+' : '−') + Math.abs(n) + '\u2069';

/** "היום ב־14:32" for today, otherwise "ב־12.10" (with the year if it is not the current one). */
export function formatSavedAt(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return 'היום ב־' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  const date = d.getDate() + '.' + (d.getMonth() + 1);
  return 'ב־' + (d.getFullYear() === now.getFullYear() ? date : date + '.' + d.getFullYear());
}
