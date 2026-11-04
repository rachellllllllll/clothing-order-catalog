/**
 * Mail drafts the admin opens in their own mail app (the site sends nothing itself), with each orderer's
 * personal sign-in link.
 */

export const LINK_NOTE = 'זה קישור אישי שמכניס ישר לחשבון שלך — אין להעביר אותו לאחרים.';

/** The personal sign-in link. The key is in the fragment, so it never reaches server logs. */
export function personalLink(key: string, roundId?: string): string {
  const url = new URL('/', window.location.origin);
  if (roundId) url.searchParams.set('round', roundId);
  url.hash = 'login=' + key;
  return url.href;
}

/** The link followed by the note that it must not be passed on. */
export const linkBlock = (link: string) => `${link}\n(${LINK_NOTE})`;

export interface MailDraft {
  subject: string;
  body: string;
}

/**
 * Fills `{שם}`, `{סבב}`, `{תאריך}` (the round's closing day) and `{קישור}` (the personal link with its note) in a
 * message template. Without a closing date, body lines that mention `{תאריך}` are left out.
 */
export function fillTemplate(
  t: MailDraft,
  vars: { name: string; round: string; date: string; link: string },
): MailDraft {
  const fill = (s: string, body: boolean) =>
    (body && !vars.date ? s.split('\n').filter((line) => !line.includes('{תאריך}')).join('\n') : s).replace(
      /\{(שם|סבב|תאריך|קישור)\}/g,
      (_, key: string) =>
        key === 'שם' ? vars.name : key === 'סבב' ? vars.round : key === 'תאריך' ? vars.date : body ? linkBlock(vars.link) : vars.link,
    );
  return { subject: fill(t.subject, false), body: fill(t.body, true) };
}

export type MailApp = 'app' | 'gmail';

const MAIL_APP_KEY = 'orderUi:mailApp';

export function readMailApp(): MailApp {
  try {
    return localStorage.getItem(MAIL_APP_KEY) === 'gmail' ? 'gmail' : 'app';
  } catch {
    return 'app';
  }
}

export function writeMailApp(app: MailApp) {
  try {
    localStorage.setItem(MAIL_APP_KEY, app);
  } catch {
    // ignore
  }
}

/** A link that opens the draft: the default mail app (mailto), or a Gmail compose tab. */
export function mailHref(app: MailApp, to: string, { subject, body }: MailDraft): string {
  const enc = encodeURIComponent;
  if (app === 'gmail') return `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(to)}&su=${enc(subject)}&body=${enc(body)}`;
  return `mailto:${to}?subject=${enc(subject)}&body=${enc(body.replace(/\r?\n/g, '\r\n'))}`;
}

/** Opens the draft from a click handler (Gmail in a new tab). */
export function openMail(app: MailApp, href: string) {
  if (app === 'gmail') window.open(href, '_blank', 'noopener');
  else window.location.href = href;
}
