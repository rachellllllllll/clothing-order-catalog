import { useEffect, useMemo, useRef, useState } from 'react';
import type { MemberDto, OrderSummary } from '../../api/_types';
import { ApiError, apiPost } from '../lib/api/client';
import { formatDay, formatSavedAt } from '../lib/catalog/text';
import type { Round } from '../lib/source/types';
import { fillTemplate, LINK_NOTE, mailHref, openMail, personalLink, readMailApp, writeMailApp, type MailApp, type MailDraft } from './mail';
import { insertMailChip, MAIL_VARS, MailEditor, type MailChip, type MailVar } from './MailEditor';

type Audience = 'all' | 'unsent';
export type Kind = 'open' | 'reminder';

interface KindSpec {
  label: string;
  templateKey: string;
  /** + round id: when each draft was opened. */
  mailedKey: string;
  audience: Audience;
  template: MailDraft;
}

/** How to order, the same in both messages: sending is a separate, required step. */
const HOW_TO =
  'איך מזמינים:\n1. נכנסים בקישור שלמטה.\n2. בוחרים פריטים (הבחירה נשמרת אוטומטית).\n' +
  '3. לוחצים "שלח הזמנה" — בפס שבראש העמוד, או בתוך הסל 🛒.\nהזמנה שלא נשלחה לא נכללת בהזמנה מהספק.';

const LINK_HELP = 'אם הקישור לא עובד, אפשר פשוט להשיב למייל הזה.';

/** The round opened (to everyone), and a reminder (to who hasn't sent yet) — each with its own saved text and marks. */
const KINDS: Record<Kind, KindSpec> = {
  open: {
    label: 'פתיחת הסבב',
    templateKey: 'orderUi:announceTemplate',
    mailedKey: 'orderUi:mailed:',
    audience: 'all',
    template: {
      subject: 'נפתח סבב הזמנות: {סבב}',
      body:
        'שלום {שם},\n\nנפתח סבב הזמנת בגדים חדש: {סבב}.\nאפשר להזמין עד {תאריך} (כולל).\n\n' +
        HOW_TO +
        '\nאחרי השליחה אפשר עדיין לשנות — ואז ללחוץ "שליחת עדכון".\n\nלכניסה ולהזמנה:\n{קישור}\n\n' +
        LINK_HELP +
        '\n\nתודה!',
    },
  },
  reminder: {
    label: 'תזכורת',
    templateKey: 'orderUi:reminderTemplate',
    mailedKey: 'orderUi:mailedReminder:',
    audience: 'unsent',
    template: {
      subject: 'תזכורת: סבב ההזמנות {סבב}',
      body:
        'שלום {שם},\n\nשמנו לב שעדיין לא שלחת הזמנה בסבב {סבב}.\nלתשומת לבך, אפשר להזמין עד {תאריך} (כולל).\n\n' +
        HOW_TO +
        '\nאם כבר התחלת לבחור — הבחירה שלך שמורה, נשאר רק שלב 3.\n\nלכניסה:\n{קישור}\n\n' +
        LINK_HELP +
        '\n\nתודה!',
    },
  },
};

/** Earlier default texts: a template saved unchanged from one of them follows the current default. */
const OLD_DEFAULT_BODIES = new Set([
  'שלום {שם},\n\nנפתח סבב הזמנת בגדים חדש: {סבב}.\nאפשר להזמין עד {תאריך} (כולל).\n\nלכניסה ולהזמנה:\n{קישור}\n\nתודה!',
  'שלום {שם},\n\nשמנו לב שעדיין לא שלחת הזמנה בסבב {סבב}.\nלתשומת לבך, אפשר להזמין עד {תאריך} (כולל).\n\n' +
    'אם כבר התחלת להזמין, הסל שלך שמור — צריך רק להיכנס וללחוץ "שלח הזמנה".\n\nלכניסה:\n{קישור}\n\nתודה!',
]);

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

const sameName = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();

const LINK_TITLE = 'הקישור האישי של המזמין — מכניס ישר לחשבון שלו. תקף 30 יום; קוד חדש למזמין מבטל אותו.';

function readTemplate(kind: Kind): MailDraft {
  const t = readJson<Partial<MailDraft>>(KINDS[kind].templateKey, {});
  const subject = typeof t.subject === 'string' ? t.subject : KINDS[kind].template.subject;
  if (typeof t.body === 'string' && OLD_DEFAULT_BODIES.has(t.body)) return { subject, body: KINDS[kind].template.body };
  return typeof t.subject === 'string' && typeof t.body === 'string' ? { subject: t.subject, body: t.body } : KINDS[kind].template;
}

const readMarks = (kind: Kind, roundId: string) => readJson<Record<string, string>>(KINDS[kind].mailedKey + roundId, {});

interface AnnounceMailProps {
  round: Round;
  summaries: OrderSummary[] | null;
  /** The message shown first: the opening one right after publishing, otherwise a reminder. */
  initialKind: Kind;
  onClose: () => void;
  onSignedOut: () => void;
}

/**
 * A message about the round to the orderers — the opening announcement or a reminder: an editable template, filled
 * in per orderer with their name and personal sign-in link. Each draft opens in the admin's own mail app, to check
 * and send.
 */
export function AnnounceMail({ round, summaries, initialKind, onClose, onSignedOut }: AnnounceMailProps) {
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [kind, setKind] = useState<Kind>(initialKind);
  const [template, setTemplate] = useState<MailDraft>(() => readTemplate(kind));
  const [audience, setAudience] = useState<Audience>(KINDS[kind].audience);
  const [mailApp, setMailApp] = useState<MailApp>(readMailApp);
  // When each draft was opened (kept per round and message kind on this device, so nobody gets it twice by mistake).
  const [mailed, setMailed] = useState<Record<string, string>>(() => readMarks(kind, round.id));
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showWithMail, setShowWithMail] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiPost<{ members: MemberDto[] }>('/api/admin', { action: 'members' });
        const active = res.members.filter((m) => m.active);
        const { links } = await apiPost<{ links: Record<string, string> }>('/api/admin', {
          action: 'loginLinks',
          ids: active.map((m) => m.id),
        });
        if (cancelled) return;
        setMembers(active);
        setLinks(links);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) onSignedOut();
        else setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onSignedOut]);

  const sentNames = useMemo(
    () => new Set((summaries ?? []).filter((s) => s.submittedAt).map((s) => sameName(s.name))),
    [summaries],
  );
  const recipients = members?.filter((m) => audience === 'all' || !sentNames.has(sameName(m.name))) ?? [];
  const mailable = recipients.filter((m) => m.email && links[m.id]);
  const next = mailable.find((m) => !mailed[m.id]);
  const preview = recipients.find((m) => m.id === previewId) ?? recipients[0] ?? null;
  const noLink = !template.body.includes('{קישור}');
  const noDate = !round.closesOn && template.body.includes('{תאריך}');

  const pickKind = (k: Kind) => {
    setKind(k);
    setTemplate(readTemplate(k));
    setAudience(KINDS[k].audience);
    setMailed(readMarks(k, round.id));
    setPreviewId(null);
  };

  const editTemplate = (patch: Partial<MailDraft>) => {
    const t = { ...template, ...patch };
    setTemplate(t);
    writeJson(KINDS[kind].templateKey, t);
  };

  const draftFor = (m: MemberDto) =>
    fillTemplate(template, {
      name: m.name,
      round: round.name,
      date: round.closesOn ? formatDay(round.closesOn) : '',
      link: personalLink(links[m.id] ?? '', round.id),
    });

  const markMailed = (m: MemberDto) => {
    const marks = { ...mailed, [m.id]: new Date().toISOString() };
    setMailed(marks);
    writeJson(KINDS[kind].mailedKey + round.id, marks);
    setPreviewId(m.id);
  };

  const clearMarks = () => {
    if (!window.confirm(`לנקות את הסימונים "נפתח" של ה${KINDS[kind].label}? (למשל כדי לשלוח אותה שוב)`)) return;
    setMailed({});
    writeJson(KINDS[kind].mailedKey + round.id, {});
  };

  function openNext() {
    if (!next) return;
    openMail(mailApp, mailHref(mailApp, next.email, draftFor(next)));
    markMailed(next);
  }

  async function copy(m: MemberDto) {
    try {
      await navigator.clipboard.writeText(draftFor(m).body);
      setCopied(m.id);
      setError('');
    } catch {
      setError('ההעתקה נכשלה.');
    }
  }

  const mailedCount = mailable.filter((m) => mailed[m.id]).length;
  // Without a mail address the message is copied by hand, so those come first; the rest go through "next mail".
  const noMail = recipients.filter((m) => !m.email);
  const withMail = recipients.filter((m) => m.email);
  const withMailNoLink = withMail.filter((m) => !links[m.id]).length;

  const date = round.closesOn ? formatDay(round.closesOn) : '';
  const chips = (body: boolean): Record<MailVar, MailChip> => ({
    שם: { label: preview?.name ?? 'שם המזמין', title: 'שם המזמין — מתמלא לכל מזמין' },
    סבב: { label: round.name, title: 'שם הסבב' },
    תאריך: date
      ? { label: date, title: 'היום האחרון להזמנות' }
      : { label: 'תאריך לא נקבע', title: 'השורה הזו לא תיכלל במייל עד שייקבע תאריך סגירה', warn: true },
    קישור: { label: '🔗 קישור אישי', note: body ? `(${LINK_NOTE})` : undefined, title: LINK_TITLE },
  });
  const bodyRef = useRef<HTMLDivElement>(null);

  const row = (m: MemberDto) => (
    <tr key={m.id} className={preview?.id === m.id ? 'selected' : undefined}>
      <td>
        <button type="button" className="btn-link" title="הצגת המייל שלו למעלה" onClick={() => setPreviewId(m.id)}>
          <bdi>{m.name}</bdi>
        </button>
      </td>
      <td>{m.email ? <bdi dir="ltr">{m.email}</bdi> : <span className="muted small">אין מייל</span>}</td>
      <td className="small">
        {!links[m.id] ? (
          <span className="danger">אין קישור — הנפיקו קוד חדש</span>
        ) : mailed[m.id] ? (
          <span>נפתח ✓ {formatSavedAt(mailed[m.id])}</span>
        ) : null}
      </td>
      <td>
        {links[m.id] &&
          (m.email ? (
            <a
              className={(mailed[m.id] ? 'btn-secondary' : 'btn-primary') + ' btn-sm'}
              href={mailHref(mailApp, m.email, draftFor(m))}
              {...(mailApp === 'gmail' && { target: '_blank', rel: 'noopener' })}
              onClick={() => markMailed(m)}
            >
              {mailed[m.id] ? 'פתיחה שוב' : '✉ פתיחת מייל'}
            </a>
          ) : (
            <button type="button" className="btn-secondary btn-sm" onClick={() => void copy(m)}>
              {copied === m.id ? 'הועתק ✓' : 'העתקת ההודעה'}
            </button>
          ))}
      </td>
    </tr>
  );

  return (
    <section className="panel admin-main admin-announce">
      <div className="admin-issued-head">
        <h3>
          ✉ הודעה למזמינים על הסבב <bdi>{round.name}</bdi>
        </h3>
        <button type="button" className="btn-secondary btn-sm" onClick={onClose}>
          סגירה
        </button>
      </div>
      <p className="small muted announce-help">
        האתר לא שולח מיילים בעצמו: כל לחיצה פותחת טיוטה מוכנה באפליקציית המייל שלך, עם השם והקישור האישי של המזמין — בודקים
        ולוחצים "שליחה".
      </p>
      <div className="admin-seg" role="group" aria-label="סוג ההודעה">
        {(Object.keys(KINDS) as Kind[]).map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => kind !== k && pickKind(k)}>
            {KINDS[k].label}
          </button>
        ))}
      </div>

      <div className="announce-compose">
        <div className="small muted">
          כך ייראה המייל{preview && <> ל<bdi>{preview.name}</bdi></>} — אפשר לערוך את הטקסט כאן. החלקים הצבועים (שם, סבב, תאריך, קישור)
          מתמלאים לכל מזמין. לחיצה על שם בטבלה מציגה את המייל שלו.
        </div>
        <MailEditor
          label="נושא"
          singleLine
          value={template.subject}
          chips={chips(false)}
          onChange={(subject) => editTemplate({ subject })}
        />
        <MailEditor
          label="הודעה"
          editorRef={bodyRef}
          value={template.body}
          chips={chips(true)}
          onChange={(body) => editTemplate({ body })}
        />
        <div className="announce-insert small">
          <span className="muted">הוספה:</span>
          {MAIL_VARS.map((v) => (
            <button
              key={v}
              type="button"
              className="mail-chip"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertMailChip(v, bodyRef.current)}
            >
              + {v}
            </button>
          ))}
          <button type="button" className="btn-link" onClick={() => editTemplate(KINDS[kind].template)}>
            חזרה להודעה המקורית
          </button>
        </div>
        {noLink && <div className="small danger">בהודעה אין קישור אישי — המזמינים לא יקבלו קישור כניסה.</div>}
        {noDate && (
          <div className="small muted">
            לסבב לא נקבע תאריך סגירה, אז השורות עם "תאריך לא נקבע" לא ייכללו במייל. אפשר לקבוע אותו ב-"📅 קביעת
            תאריך סגירה" למעלה.
          </div>
        )}
      </div>

      <div className="admin-toolbar">
        <div className="admin-seg" role="group" aria-label="נמענים">
          <button type="button" aria-pressed={audience === 'all'} onClick={() => setAudience('all')}>
            כל המזמינים הפעילים
          </button>
          <button type="button" aria-pressed={audience === 'unsent'} onClick={() => setAudience('unsent')}>
            מי שעוד לא שלח הזמנה
          </button>
        </div>
        <MailAppPicker value={mailApp} onChange={setMailApp} />
        <div className="admin-toolbar-end">
          {members && (
            <span className="small muted">
              נפתחו {mailedCount} מתוך {mailable.length}
            </span>
          )}
          <button type="button" className="btn-primary btn-sm" disabled={!next} onClick={openNext}>
            {next ? (
              <>
                ✉ פתיחת המייל הבא — <bdi>{next.name}</bdi>
              </>
            ) : mailable.length ? (
              'כל המיילים נפתחו ✓'
            ) : (
              '✉ פתיחת המייל הבא'
            )}
          </button>
        </div>
      </div>
      {error && <div className="status error">{error}</div>}

      {!members ? (
        !error && <div className="muted">טוען את רשימת המזמינים…</div>
      ) : !recipients.length ? (
        <div className="muted">{audience === 'unsent' ? 'כל המזמינים כבר שלחו הזמנה.' : 'אין מזמינים פעילים ברשימה.'}</div>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table admin-announce-table">
            <thead>
              <tr>
                <th>שם</th>
                <th>מייל</th>
                <th>סטטוס</th>
                <th />
              </tr>
            </thead>
            {noMail.length > 0 && (
              <tbody>
                <tr className="announce-group">
                  <td colSpan={4}>
                    בלי מייל — מעתיקים את ההודעה ושולחים ידנית ({noMail.length})
                  </td>
                </tr>
                {noMail.map(row)}
              </tbody>
            )}
            {withMail.length > 0 && (
              <tbody>
                <tr className="announce-group">
                  <td colSpan={4}>
                    <button type="button" className="btn-link" aria-expanded={showWithMail} onClick={() => setShowWithMail((v) => !v)}>
                      {showWithMail ? '▾' : '▸'} עם מייל ({withMail.length})
                    </button>
                    {withMailNoLink > 0 && <span className="danger small"> · {withMailNoLink} בלי קישור</span>}
                  </td>
                </tr>
                {showWithMail && withMail.map(row)}
              </tbody>
            )}
          </table>
        </div>
      )}
      {mailedCount > 0 && (
        <div>
          <button type="button" className="btn-link small" onClick={clearMarks}>
            ניקוי הסימונים "נפתח"
          </button>
        </div>
      )}
    </section>
  );
}

/** Where mail drafts open: the default mail app (mailto) or Gmail in the browser. Remembered on this device. */
export function MailAppPicker({ value, onChange }: { value: MailApp; onChange: (app: MailApp) => void }) {
  return (
    <label className="small mail-app-picker">
      פתיחת מיילים ב:
      <select
        value={value}
        onChange={(e) => {
          const app = e.target.value as MailApp;
          writeMailApp(app);
          onChange(app);
        }}
      >
        <option value="app">אפליקציית המייל</option>
        <option value="gmail">Gmail בדפדפן</option>
      </select>
    </label>
  );
}
