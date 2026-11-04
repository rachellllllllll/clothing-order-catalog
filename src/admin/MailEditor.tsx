import { useLayoutEffect, useRef } from 'react';

/** The parts of a message template filled in per orderer: shown as locked chips inside the editable text. */
export type MailVar = 'שם' | 'סבב' | 'תאריך' | 'קישור';
export const MAIL_VARS: readonly MailVar[] = ['שם', 'סבב', 'תאריך', 'קישור'];

export interface MailChip {
  label: string;
  /** A second, muted line inside the chip (the "don't pass the link on" note). */
  note?: string;
  title?: string;
  warn?: boolean;
}

const VAR_SPLIT = /\{(שם|סבב|תאריך|קישור)\}/;
const VAR_ALL = /\{(שם|סבב|תאריך|קישור)\}/g;

function chipElement(v: MailVar, chip: MailChip): HTMLElement {
  const el = document.createElement('span');
  el.className = 'mail-chip' + (chip.warn ? ' warn' : '');
  el.contentEditable = 'false';
  el.dataset.var = v;
  if (chip.title) el.title = chip.title;
  el.textContent = chip.label;
  if (chip.note) {
    const note = document.createElement('span');
    note.className = 'mail-chip-note';
    note.textContent = '\n' + chip.note;
    el.append(note);
  }
  return el;
}

/** The template text back from the edited DOM: chips become `{var}`, line breaks and blocks become newlines. */
function serializeRaw(root: Node): string {
  let out = '';
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += (child as Text).data;
      else if (child instanceof HTMLElement) {
        if (child.dataset.var) out += `{${child.dataset.var}}`;
        else if (child.tagName === 'BR') out += '\n';
        else {
          if ((child.tagName === 'DIV' || child.tagName === 'P') && out && !out.endsWith('\n')) out += '\n';
          walk(child);
        }
      }
    }
  };
  walk(root);
  return out;
}

const serialize = (root: HTMLElement) => serializeRaw(root).replace(/\n+$/, '');

/** The caret's position in the template text, or null when the caret is not in `root`. */
function caretOffset(root: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !root.contains(sel.anchorNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(sel.anchorNode!, sel.anchorOffset);
  const box = document.createElement('div');
  box.append(range.cloneContents());
  return serializeRaw(box).length;
}

/** Puts the caret at a template-text position in a freshly rendered editor (text nodes and chips only). */
function setCaret(root: HTMLElement, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  let pos = 0;
  for (const node of root.childNodes) {
    const isText = node.nodeType === Node.TEXT_NODE;
    const len = isText ? (node as Text).length : `{${(node as HTMLElement).dataset.var}}`.length;
    if (pos + len >= offset) {
      if (isText) range.setStart(node, offset - pos);
      else range.setStartAfter(node);
      range.collapse(true);
      break;
    }
    pos += len;
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Inserts a chip at the caret of the focused mail editor (or at the end of `fallback`). */
export function insertMailChip(v: MailVar, fallback: HTMLElement | null) {
  const sel = window.getSelection();
  const node = sel?.rangeCount ? sel.anchorNode : null;
  const inEditor = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.mail-editor');
  const editor = inEditor ?? fallback;
  if (!editor || !sel) return;
  if (!inEditor) {
    editor.focus();
    sel.selectAllChildren(editor);
    sel.collapseToEnd();
  }
  // Through the browser's editing command, so the insertion can be undone (Ctrl+Z) like typing.
  document.execCommand('insertText', false, `{${v}}`);
}

interface MailEditorProps {
  value: string;
  chips: Record<MailVar, MailChip>;
  onChange: (value: string) => void;
  label: string;
  singleLine?: boolean;
  editorRef?: React.RefObject<HTMLDivElement | null>;
}

/**
 * A message template edited as it will read: free text with the per-orderer parts (name, round, date, link) as
 * locked chips. The DOM is rebuilt only for changes from outside (another template, another orderer's values), so
 * typing keeps the caret and the browser's undo.
 */
export function MailEditor({ value, chips, onChange, label, singleLine, editorRef }: MailEditorProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = editorRef ?? ownRef;
  const shown = useRef<{ value: string; chips: string } | null>(null);
  const chipsKey = JSON.stringify(chips);

  const render = (root: HTMLElement, text: string) => {
    const parts = text.split(VAR_SPLIT);
    root.replaceChildren(
      ...parts.map((p, i) => (i % 2 ? chipElement(p as MailVar, chips[p as MailVar]) : document.createTextNode(p))),
    );
  };

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || (shown.current?.value === value && shown.current.chips === chipsKey)) return;
    render(root, value);
    shown.current = { value, chips: chipsKey };
  });

  const emit = () => {
    const root = ref.current;
    if (!root) return;
    let text = serialize(root);
    if (singleLine) text = text.replace(/\s*\n\s*/g, ' ');
    // A `{var}` typed, pasted or inserted as text turns into its chip; the caret stays where it was in the text.
    const typedVar = (text.match(VAR_ALL) ?? []).length !== root.querySelectorAll('[data-var]').length;
    const caret = typedVar ? caretOffset(root) : null;
    if (typedVar) render(root, text);
    shown.current = { value: text, chips: chipsKey };
    if (caret != null) setCaret(root, caret);
    onChange(text);
  };

  return (
    <div
      ref={ref}
      className={'mail-editor' + (singleLine ? ' single' : '')}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline={!singleLine}
      aria-label={label}
      spellCheck
      onInput={emit}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (!singleLine) document.execCommand('insertLineBreak');
      }}
      onPaste={(e) => {
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, singleLine ? text.replace(/\s*\n\s*/g, ' ') : text);
      }}
      onDrop={(e) => e.preventDefault()}
    />
  );
}
