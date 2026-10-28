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
  return '$' + Number(v).toFixed(2);
}

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
