export interface ImageRef {
  /** Small image for cards, thumbnails and print. */
  thumb: string;
  /** Large image for the lightbox. */
  full: string;
}

export interface CatalogSource {
  kind: 'drive' | 'local';
  excelName: string;
  excelData: ArrayBuffer;
  /** Changes whenever the catalog file changes; used to scope saved drafts. */
  version: string;
  /** normalizeText(image file base name) -> image URLs */
  images: Map<string, ImageRef>;
  dispose(): void;
}

export const EXCEL_RE = /\.xlsx$/i;
