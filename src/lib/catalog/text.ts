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
