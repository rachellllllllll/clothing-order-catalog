/**
 * Minimal XLSX reader/writer based on JSZip + DOMParser (no SheetJS dependency).
 * Reads the first worksheet as a 1-based grid, and can patch cell values in place
 * so the exported file keeps all original styling, column widths, merges, etc.
 */
import JSZip from 'jszip';

export type CellValue = string | number;

export interface SheetGrid {
  sheetName: string;
  maxRow: number;
  maxCol: number;
  /** 1-based row/col. Returns '' for empty cells. */
  get(row: number, col: number): CellValue;
}

export interface CellUpdate {
  row: number;
  col: number;
  /** '' or null clears the value but keeps the cell style. */
  value: CellValue | null;
}

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export function colToLetters(col: number): string {
  let n = col;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function lettersToCol(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function parseRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (!m) return null;
  return { col: lettersToCol(m[1]), row: parseInt(m[2], 10) };
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

function children(node: Element, localName: string): Element[] {
  return Array.from(node.children).filter((c) => c.localName === localName);
}

async function readXml(zip: JSZip, path: string): Promise<Document | null> {
  const f = zip.file(path);
  return f ? parseXml(await f.async('text')) : null;
}

async function firstSheetInfo(zip: JSZip): Promise<{ name: string; path: string }> {
  const wb = await readXml(zip, 'xl/workbook.xml');
  if (!wb) throw new Error('הקובץ אינו קובץ XLSX תקין (חסר workbook.xml).');
  const sheet = wb.getElementsByTagNameNS(NS_MAIN, 'sheet')[0];
  if (!sheet) throw new Error('לא נמצא גליון בקובץ האקסל.');

  const name = sheet.getAttribute('name') || 'Sheet1';
  const rId = sheet.getAttributeNS(NS_REL, 'id') || sheet.getAttribute('r:id') || '';

  const rels = await readXml(zip, 'xl/_rels/workbook.xml.rels');
  if (rels && rId) {
    for (const rel of Array.from(rels.getElementsByTagName('Relationship'))) {
      if (rel.getAttribute('Id') !== rId) continue;
      const target = rel.getAttribute('Target') || '';
      const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      if (zip.file(path)) return { name, path };
    }
  }
  if (zip.file('xl/worksheets/sheet1.xml')) return { name, path: 'xl/worksheets/sheet1.xml' };
  throw new Error('לא נמצא קובץ הגליון בתוך האקסל.');
}

function textOf(node: Element): string {
  // Concatenate <t> runs, skipping phonetic hints (<rPh>).
  let out = '';
  for (const t of Array.from(node.getElementsByTagNameNS(NS_MAIN, 't'))) {
    if (t.parentElement?.localName === 'rPh') continue;
    out += t.textContent || '';
  }
  return out;
}

async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const doc = await readXml(zip, 'xl/sharedStrings.xml');
  if (!doc) return [];
  return children(doc.documentElement, 'si').map(textOf);
}

function readCellValue(c: Element, shared: string[]): CellValue {
  const t = c.getAttribute('t');
  if (t === 'inlineStr') {
    const is = children(c, 'is')[0];
    return is ? textOf(is) : '';
  }
  const v = children(c, 'v')[0];
  if (!v) return '';
  const raw = v.textContent || '';
  switch (t) {
    case 's':
      return shared[parseInt(raw, 10)] ?? '';
    case 'str':
      return raw;
    case 'b':
      return raw === '1' ? 'TRUE' : 'FALSE';
    case 'e':
      return '';
    default: {
      const n = Number(raw);
      return raw !== '' && Number.isFinite(n) ? n : raw;
    }
  }
}

export async function readFirstSheet(data: ArrayBuffer): Promise<SheetGrid> {
  const zip = await JSZip.loadAsync(data);
  const { name, path } = await firstSheetInfo(zip);
  const shared = await readSharedStrings(zip);
  const doc = await readXml(zip, path);
  if (!doc) throw new Error('לא ניתן לקרוא את הגליון.');

  const cells = new Map<string, CellValue>();
  let maxRow = 0;
  let maxCol = 0;

  for (const rowEl of Array.from(doc.getElementsByTagNameNS(NS_MAIN, 'row'))) {
    let implicitRow = parseInt(rowEl.getAttribute('r') || '', 10);
    if (!Number.isFinite(implicitRow)) implicitRow = maxRow + 1;
    let implicitCol = 0;
    for (const c of children(rowEl, 'c')) {
      const ref = parseRef(c.getAttribute('r') || '');
      const row = ref ? ref.row : implicitRow;
      const col = ref ? ref.col : implicitCol + 1;
      implicitCol = col;
      const value = readCellValue(c, shared);
      if (value === '') continue;
      cells.set(row + ':' + col, value);
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }
  }

  return {
    sheetName: name,
    maxRow,
    maxCol,
    get: (row, col) => cells.get(row + ':' + col) ?? '',
  };
}

function findOrCreateRow(doc: Document, sheetData: Element, row: number): Element {
  let before: Element | null = null;
  for (const r of children(sheetData, 'row')) {
    const n = parseInt(r.getAttribute('r') || '', 10);
    if (n === row) return r;
    if (n > row) {
      before = r;
      break;
    }
  }
  const el = doc.createElementNS(NS_MAIN, 'row');
  el.setAttribute('r', String(row));
  sheetData.insertBefore(el, before);
  return el;
}

function findOrCreateCell(doc: Document, rowEl: Element, row: number, col: number): Element {
  const ref = colToLetters(col) + row;
  let before: Element | null = null;
  for (const c of children(rowEl, 'c')) {
    const parsed = parseRef(c.getAttribute('r') || '');
    if (!parsed) continue;
    if (parsed.col === col) return c;
    if (parsed.col > col) {
      before = c;
      break;
    }
  }
  const el = doc.createElementNS(NS_MAIN, 'c');
  el.setAttribute('r', ref);
  rowEl.insertBefore(el, before);
  // "spans" is only an optimization hint; drop it so it can't contradict the new cell.
  rowEl.removeAttribute('spans');
  return el;
}

/** Returns true if a formula was removed from the cell. */
function setCell(doc: Document, c: Element, value: CellValue | null): boolean {
  let removedFormula = false;
  for (const child of Array.from(c.children)) {
    if (child.localName === 'f') removedFormula = true;
    if (['f', 'v', 'is'].includes(child.localName)) c.removeChild(child);
  }
  c.removeAttribute('t');
  if (value === '' || value == null) return removedFormula;

  if (typeof value === 'number') {
    const v = doc.createElementNS(NS_MAIN, 'v');
    v.textContent = String(value);
    c.appendChild(v);
  } else {
    c.setAttribute('t', 'inlineStr');
    const is = doc.createElementNS(NS_MAIN, 'is');
    const t = doc.createElementNS(NS_MAIN, 't');
    t.textContent = value;
    is.appendChild(t);
    c.appendChild(is);
  }
  return removedFormula;
}

async function removeCalcChain(zip: JSZip): Promise<void> {
  if (!zip.file('xl/calcChain.xml')) return;
  zip.remove('xl/calcChain.xml');

  const ct = await zip.file('[Content_Types].xml')?.async('text');
  if (ct) zip.file('[Content_Types].xml', ct.replace(/<Override[^>]*calcChain\.xml"[^>]*\/>/g, ''));

  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('text');
  if (rels) zip.file('xl/_rels/workbook.xml.rels', rels.replace(/<Relationship[^>]*calcChain\.xml"[^>]*\/>/g, ''));
}

/** Writes values into the first worksheet of the original file, keeping all formatting. */
export async function patchFirstSheet(data: ArrayBuffer, updates: CellUpdate[]): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(data);
  const { path } = await firstSheetInfo(zip);
  const doc = await readXml(zip, path);
  if (!doc) throw new Error('לא ניתן לקרוא את הגליון.');

  const sheetData = doc.getElementsByTagNameNS(NS_MAIN, 'sheetData')[0];
  if (!sheetData) throw new Error('מבנה גליון לא תקין (חסר sheetData).');

  let removedFormula = false;
  for (const u of updates) {
    const rowEl = findOrCreateRow(doc, sheetData, u.row);
    const cell = findOrCreateCell(doc, rowEl, u.row, u.col);
    if (setCell(doc, cell, u.value)) removedFormula = true;
  }
  if (removedFormula) await removeCalcChain(zip);

  const xml = new XMLSerializer().serializeToString(doc);
  zip.file(path, xml.startsWith('<?xml') ? xml : XML_DECL + xml);

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
