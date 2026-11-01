import type { Catalog } from '../catalog/types';

export interface ImageRef {
  /** Small image for cards, thumbnails and print. */
  thumb: string;
  /** Large image for the lightbox. */
  full: string;
}

export interface CatalogSource {
  kind: 'drive' | 'local';
  /** The catalog file name (the round name for rounds edited on the admin page) — shown on the printout. */
  excelName: string;
  /** The catalog Excel file; null for rounds edited on the admin page (no order file to fill in). */
  excelData: ArrayBuffer | null;
  catalog: Catalog;
  /** Stable catalog identity (its file name, not its modified time) — scopes the saved draft. */
  catalogKey: string;
  /** normalizeText(image file base name) -> image URLs */
  images: Map<string, ImageRef>;
  dispose(): void;
}

export const EXCEL_RE = /\.xlsx$/i;

/** An order round = a subfolder of the Drive catalog folder (with its lock/archive state). */
export type { RoundDto as Round } from '../../../api/_types';
