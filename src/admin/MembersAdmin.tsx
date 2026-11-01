import { useCallback, useEffect, useState } from 'react';
import type { IssuedCode, MemberDto, NewMember } from '../../api/_types';
import { ApiError, apiPost } from '../lib/api/client';
import { formatSavedAt } from '../lib/catalog/text';
import { errText } from './RoundAdmin';

type Skipped = { name: string; reason: 'duplicate' | 'invalid' };

/** Codes just issued — shown once, until the admin closes the box. */
interface Issued {
  title: string;
  codes: IssuedCode[];
  skipped: Skipped[];
}

const byName = (list: MemberDto[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, 'he'));

const loginLink = (name: string) => `${window.location.origin}/?name=${encodeURIComponent(name)}`;

/** What the admin pastes to the orderer: the link (with the name filled in), the name and the code. */
const shareText = ({ member, code }: IssuedCode) =>
  `כניסה להזמנת בגדים: ${loginLink(member.name)}\nשם: ${member.name}\nקוד: ${code}`;

const skippedText = (s: Skipped) => `${s.name} (${s.reason === 'duplicate' ? 'כבר ברשימה' : 'שם לא תקין'})`;

/** One person per line: a name, optionally followed by a comma or tab and a phone number (as pasted from a sheet). */
export function parseMemberLines(text: string): NewMember[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(.+?)\s*[,\t]\s*([\d +()-]{7,20})$/.exec(line);
      return m ? { name: m[1], phone: m[2].trim() } : { name: line };
    });
}

/** The orderers list: only people on it can sign in to order. */
export function MembersAdmin({ onSignedOut }: { onSignedOut: () => void }) {
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: '' });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState<'one' | 'many' | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setStatus({ text: errText(err), error: true });
    },
    [onSignedOut],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMembers((await apiPost<{ members: MemberDto[] }>('/api/admin', { action: 'members' })).members);
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
  }, [fail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<boolean | void>): Promise<boolean> {
    setBusy(true);
    setStatus({ text: '' });
    try {
      return (await action()) !== false;
    } catch (err) {
      fail(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const upsert = (m: MemberDto) => setMembers((list) => byName([...(list ?? []).filter((x) => x.id !== m.id), m]));

  const add = (entries: NewMember[]) =>
    run(async () => {
      const res = await apiPost<{ added: IssuedCode[]; skipped: Skipped[] }>('/api/admin', { action: 'addMembers', members: entries });
      if (!res.added.length) {
        setStatus({ text: 'לא נוסף אף אחד: ' + res.skipped.map(skippedText).join(', '), error: true });
        return false;
      }
      setMembers((list) => byName([...(list ?? []), ...res.added.map((a) => a.member)]));
      setAdding(null);
      setIssued({
        title: res.added.length === 1 ? `נוסף לרשימה: ${res.added[0].member.name}` : `נוספו ${res.added.length} מזמינים לרשימה`,
        codes: res.added,
        skipped: res.skipped,
      });
    });

  const issueCode = (m: MemberDto) =>
    window.confirm(`להנפיק קוד חדש ל${m.name}? הקוד הקודם יפסיק לעבוד, ומכשירים שמחוברים איתו ינותקו.`) &&
    run(async () => {
      const res = await apiPost<IssuedCode>('/api/admin', { action: 'newCode', id: m.id });
      upsert(res.member);
      setIssued({ title: `קוד חדש ל${m.name}`, codes: [res], skipped: [] });
    });

  const update = (m: MemberDto, patch: { name?: string; phone?: string; active?: boolean }) =>
    run(async () => {
      const res = await apiPost<{ member: MemberDto }>('/api/admin', { action: 'updateMember', id: m.id, ...patch });
      upsert(res.member);
      setEditing(null);
    });

  const setActive = (m: MemberDto, active: boolean) =>
    (active ||
      window.confirm(`להשבית את הכניסה של ${m.name}? אי אפשר יהיה להיכנס עד שהכניסה תופעל מחדש. ההזמנות הקיימות נשמרות.`)) &&
    void update(m, { active });

  const remove = (m: MemberDto) =>
    window.confirm(`למחוק את ${m.name} מהרשימה?`) &&
    run(async () => {
      await apiPost('/api/admin', { action: 'deleteMember', id: m.id });
      setMembers((list) => list?.filter((x) => x.id !== m.id) ?? null);
      setStatus({ text: `${m.name} נמחק/ה מהרשימה.` });
    });

  const fillFromPast = async () => {
    const res = await apiPost<{ names: string[] }>('/api/admin', { action: 'pastOrderers' });
    return res.names;
  };

  const query = search.trim().toLowerCase();
  const visible = members?.filter((m) => !query || m.name.toLowerCase().includes(query) || m.phone.includes(query)) ?? null;
  const inactive = members?.filter((m) => !m.active).length ?? 0;

  return (
    <section className="panel admin-main">
      <div className="admin-toolbar">
        <h3>רשימת מזמינים</h3>
        {members && (
          <span className="muted">
            {members.length - inactive} פעילים{inactive > 0 && ` · ${inactive} מושבתים`}
          </span>
        )}
        <input
          type="search"
          className="admin-search"
          placeholder="חיפוש שם או טלפון…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="admin-toolbar-end">
          <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => setAdding('one')}>
            + הוספת מזמין
          </button>
          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setAdding('many')}>
            הוספת כמה יחד
          </button>
          <button type="button" className="btn-secondary btn-sm" disabled={loading} onClick={() => void load()}>
            ↻ {loading ? 'טוען…' : 'רענון'}
          </button>
        </div>
      </div>
      <p className="muted admin-members-help">
        רק מי שברשימה יכול להיכנס להזמנות, עם השם והקוד שלו (6 ספרות). הקוד מוצג פעם אחת — כשמוסיפים מזמין או מנפיקים לו
        קוד חדש.
      </p>

      {adding === 'one' && <AddOne busy={busy} onAdd={add} onCancel={() => setAdding(null)} />}
      {adding === 'many' && (
        <AddMany busy={busy} onAdd={add} onCancel={() => setAdding(null)} loadPast={fillFromPast} onError={fail} />
      )}
      {issued && <IssuedCodes issued={issued} onClose={() => setIssued(null)} />}
      {status.text && <div className={'status' + (status.error ? ' error' : '')}>{status.text}</div>}

      {!visible ? (
        <div className="muted">טוען…</div>
      ) : !members?.length ? (
        <div className="admin-empty">
          <strong>הרשימה ריקה — עדיין אף אחד לא יכול להיכנס להזמנות.</strong>
          <span className="muted">הוסיפו מזמינים. אפשר גם להוסיף בבת אחת את כל מי שהזמין בסבבים קודמים.</span>
        </div>
      ) : !visible.length ? (
        <div className="muted">אין מזמינים שמתאימים לחיפוש.</div>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table admin-members">
            <thead>
              <tr>
                <th>שם</th>
                <th>טלפון</th>
                <th className="admin-col-updated">כניסה אחרונה</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((m) =>
                editing === m.id ? (
                  <EditRow key={m.id} member={m} busy={busy} onSave={(patch) => void update(m, patch)} onCancel={() => setEditing(null)} />
                ) : (
                  <tr key={m.id} className={m.active ? undefined : 'inactive'}>
                    <td>
                      <bdi>{m.name}</bdi>
                      {!m.active && <span className="chip chip-warn admin-chip">מושבת</span>}
                    </td>
                    <td>
                      <bdi dir="ltr">{m.phone}</bdi>
                    </td>
                    <td className="admin-col-updated">
                      {m.lastLoginAt ? formatSavedAt(m.lastLoginAt) : <span className="muted">עדיין לא נכנס/ה</span>}
                    </td>
                    <td>
                      <div className="admin-row-actions">
                        <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setEditing(m.id)}>
                          עריכה
                        </button>
                        <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void issueCode(m)}>
                          קוד חדש
                        </button>
                        <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setActive(m, !m.active)}>
                          {m.active ? 'השבתה' : 'הפעלה'}
                        </button>
                        <button type="button" className="btn-link danger" disabled={busy} onClick={() => void remove(m)}>
                          מחיקה
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AddOne({ busy, onAdd, onCancel }: { busy: boolean; onAdd: (e: NewMember[]) => Promise<boolean>; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const valid = name.trim().length >= 2;
  return (
    <form
      className="admin-member-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) void onAdd([{ name, phone }]);
      }}
    >
      <div className="field">
        <label htmlFor="memberName">שם</label>
        <input id="memberName" type="text" maxLength={40} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="memberPhone">טלפון (לא חובה)</label>
        <input id="memberPhone" type="tel" dir="ltr" maxLength={20} value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <button type="submit" className="btn-primary btn-sm" disabled={!valid || busy}>
        הוספה וקבלת קוד
      </button>
      <button type="button" className="btn-secondary btn-sm" onClick={onCancel}>
        ביטול
      </button>
    </form>
  );
}

interface AddManyProps {
  busy: boolean;
  onAdd: (e: NewMember[]) => Promise<boolean>;
  onCancel: () => void;
  loadPast: () => Promise<string[]>;
  onError: (err: unknown) => void;
}

function AddMany({ busy, onAdd, onCancel, loadPast, onError }: AddManyProps) {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [loadingPast, setLoadingPast] = useState(false);
  const entries = parseMemberLines(text);

  async function fill() {
    setLoadingPast(true);
    setNote('');
    try {
      const have = new Set(entries.map((e) => e.name.toLowerCase()));
      const names = (await loadPast()).filter((n) => !have.has(n.toLowerCase()));
      if (!names.length) setNote('כל מי שהזמין בסבבים קודמים כבר ברשימה.');
      else {
        setText((t) => (t.trim() ? t.trimEnd() + '\n' : '') + names.join('\n'));
        setNote(`נוספו ${names.length} שמות מהזמנות קודמות — עברו עליהם ומחקו את מי שלא צריך.`);
      }
    } catch (err) {
      onError(err);
    } finally {
      setLoadingPast(false);
    }
  }

  return (
    <div className="admin-member-form admin-member-many">
      <label htmlFor="memberLines">שם בכל שורה. אפשר להוסיף טלפון אחרי פסיק — או להדביק שתי עמודות מגיליון.</label>
      <textarea
        id="memberLines"
        rows={8}
        autoFocus
        placeholder={'משה כהן, 050-1234567\nשרה לוי'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {note && <div className="muted">{note}</div>}
      <div className="admin-actions">
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={!entries.length || busy}
          onClick={() => void onAdd(entries).then((ok) => ok && setText(''))}
        >
          הוספת {entries.length || ''} מזמינים וקבלת קודים
        </button>
        <button type="button" className="btn-secondary btn-sm" disabled={loadingPast} onClick={() => void fill()}>
          {loadingPast ? 'טוען…' : 'מילוי ממי שהזמין בסבבים קודמים'}
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={onCancel}>
          ביטול
        </button>
      </div>
    </div>
  );
}

function IssuedCodes({ issued, onClose }: { issued: Issued; onClose: () => void }) {
  const [copied, setCopied] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState('');
  const many = issued.codes.length > 1;

  async function copy(text: string, ids: string[]) {
    try {
      await navigator.clipboard.writeText(text);
      setError('');
      setCopied((cur) => new Set([...cur, ...ids]));
    } catch {
      setError('ההעתקה נכשלה — אפשר לסמן את הקוד ולהעתיק ידנית.');
    }
  }

  const close = () =>
    (copied.size > 0 || window.confirm('הקודים לא יוצגו שוב אחרי הסגירה (אפשר תמיד להנפיק קוד חדש). לסגור?')) && onClose();

  return (
    <div className="admin-issued" role="status">
      <div className="admin-issued-head">
        <strong>{issued.title}</strong>
        <div className="admin-actions">
          {many && (
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={() => void copy(issued.codes.map(shareText).join('\n\n'), issued.codes.map((c) => c.member.id))}
            >
              העתקת הכל
            </button>
          )}
          <button type="button" className="btn-secondary btn-sm" onClick={close}>
            סגירה
          </button>
        </div>
      </div>
      <div className="small">העבירו לכל מזמין את פרטי הכניסה שלו. אחרי הסגירה הקודים לא יוצגו שוב.</div>
      <table className="admin-table admin-sub-table">
        <tbody>
          {issued.codes.map((c) => (
            <tr key={c.member.id}>
              <td>
                <bdi>{c.member.name}</bdi>
              </td>
              <td>
                <span className="admin-code" dir="ltr">
                  {c.code}
                </span>
              </td>
              <td>
                <button
                  type="button"
                  className={(many ? 'btn-secondary' : 'btn-primary') + ' btn-sm'}
                  onClick={() => void copy(shareText(c), [c.member.id])}
                >
                  {copied.has(c.member.id) ? 'הועתק ✓' : 'העתקת פרטי כניסה'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <div className="status error">{error}</div>}
      {issued.skipped.length > 0 && <div className="small danger">לא נוספו: {issued.skipped.map(skippedText).join(', ')}</div>}
    </div>
  );
}

function EditRow({
  member,
  busy,
  onSave,
  onCancel,
}: {
  member: MemberDto;
  busy: boolean;
  onSave: (patch: { name: string; phone: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(member.name);
  const [phone, setPhone] = useState(member.phone);
  const valid = name.trim().length >= 2;
  const save = () => valid && !busy && onSave({ name, phone });
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') save();
    else if (e.key === 'Escape') onCancel();
  };
  return (
    <tr className="editing">
      <td>
        <input type="text" aria-label="שם" maxLength={40} autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={keys} />
      </td>
      <td>
        <input type="tel" aria-label="טלפון" dir="ltr" maxLength={20} value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={keys} />
      </td>
      <td className="admin-col-updated small muted">שינוי שם מעדכן גם את ההזמנות שלו/ה</td>
      <td>
        <div className="admin-row-actions">
          <button type="button" className="btn-primary btn-sm" disabled={!valid || busy} onClick={save}>
            שמירה
          </button>
          <button type="button" className="btn-secondary btn-sm" onClick={onCancel}>
            ביטול
          </button>
        </div>
      </td>
    </tr>
  );
}
