import { useEffect, useMemo, useState } from 'react';
import type { MemberDto, OrderSummary } from '../../api/_types';
import { ApiError, apiPost } from '../lib/api/client';
import { formatSavedAt } from '../lib/catalog/text';
import type { Round } from '../lib/source/types';
import { fillTemplate, mailHref, openMail, personalLink, readMailApp, writeMailApp, type MailApp, type MailDraft } from './mail';

const TEMPLATE_KEY = 'orderUi:announceTemplate';
const MAILED_KEY = 'orderUi:mailed:';

const DEFAULT_TEMPLATE: MailDraft = {
  subject: 'נפתח סבב הזמנות: {סבב}',
  body: 'שלום {שם},\n\nנפתח סבב הזמנת בגדים חדש: {סבב}.\n\nלכניסה ולהזמנה:\n{קישור}\n\nתודה!',
};

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

type Audience = 'all' | 'unsent';

interface AnnounceMailProps {
  round: Round;
  summaries: OrderSummary[] | null;
  onClose: () => void;
  onSignedOut: () => void;
}

/**
 * A message about the round to the orderers: one editable template, filled in per orderer with their name and
 * personal sign-in link. Each draft opens in the admin's own mail app, to check and send.
 */
export function AnnounceMail({ round, summaries, onClose, onSignedOut }: AnnounceMailProps) {
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [template, setTemplate] = useState<MailDraft>(() => {
    const t = readJson<Partial<MailDraft>>(TEMPLATE_KEY, {});
    return typeof t.subject === 'string' && typeof t.body === 'string' ? { subject: t.subject, body: t.body } : DEFAULT_TEMPLATE;
  });
  const [audience, setAudience] = useState<Audience>('all');
  const [mailApp, setMailApp] = useState<MailApp>(readMailApp);
  // When each draft was opened (kept per round on this device, so nobody gets the message twice by mistake).
  const [mailed, setMailed] = useState<Record<string, string>>(() => readJson(MAILED_KEY + round.id, {}));
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

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

  const editTemplate = (patch: Partial<MailDraft>) => {
    const t = { ...template, ...patch };
    setTemplate(t);
    writeJson(TEMPLATE_KEY, t);
  };

  const draftFor = (m: MemberDto) =>
    fillTemplate(template, { name: m.name, round: round.name, link: personalLink(links[m.id] ?? '', round.id) });

  const markMailed = (m: MemberDto) => {
    const marks = { ...mailed, [m.id]: new Date().toISOString() };
    setMailed(marks);
    writeJson(MAILED_KEY + round.id, marks);
    setPreviewId(m.id);
  };

  const clearMarks = () => {
    if (!window.confirm('לנקות את הסימונים "נפתח"? (למשל כדי לשלוח תזכורת לכולם)')) return;
    setMailed({});
    writeJson(MAILED_KEY + round.id, {});
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
  const previewDraft = preview && links[preview.id] ? draftFor(preview) : null;

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

      <div className="announce-grid">
        <div className="announce-edit">
          <div className="field">
            <label htmlFor="announceSubject">נושא</label>
            <input
              id="announceSubject"
              type="text"
              maxLength={150}
              value={template.subject}
              onChange={(e) => editTemplate({ subject: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="announceBody">הודעה</label>
            <textarea
              id="announceBody"
              rows={9}
              maxLength={1500}
              value={template.body}
              onChange={(e) => editTemplate({ body: e.target.value })}
            />
          </div>
          <div className="small muted announce-vars">
            <code>{'{שם}'}</code> שם המזמין · <code>{'{סבב}'}</code> שם הסבב · <code>{'{קישור}'}</code> הקישור האישי, ואחריו
            הערה שהוא אישי ואין להעביר אותו. הקישור תקף 30 יום; קוד חדש למזמין מבטל אותו.
          </div>
          {noLink && <div className="small danger">ההודעה לא כוללת את {'{קישור}'} — המזמינים לא יקבלו קישור כניסה.</div>}
          <div>
            <button type="button" className="btn-link" onClick={() => editTemplate(DEFAULT_TEMPLATE)}>
              חזרה להודעה המקורית
            </button>
          </div>
        </div>
        <div className="announce-preview">
          <div className="small muted">
            תצוגה מקדימה{preview && <> — <bdi>{preview.name}</bdi></>}
          </div>
          {previewDraft ? (
            <>
              <strong>{previewDraft.subject}</strong>
              <pre>{previewDraft.body}</pre>
            </>
          ) : (
            <div className="muted">{members ? 'אין נמענים.' : 'טוען…'}</div>
          )}
        </div>
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
            <tbody>
              {recipients.map((m) => (
                <tr key={m.id} className={preview?.id === m.id ? 'selected' : undefined}>
                  <td>
                    <button type="button" className="btn-link" title="הצגה בתצוגה המקדימה" onClick={() => setPreviewId(m.id)}>
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
              ))}
            </tbody>
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
