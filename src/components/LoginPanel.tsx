import { useState } from 'react';
import { ApiError } from '../lib/api/client';
import { isReadOnly, useOrderStore } from '../store/orderStore';
import { login } from '../store/orderSync';

/** Sign-in to the open Drive round with a name and a 4-digit code (shown instead of the catalog). */
export function LoginPanel() {
  const pending = useOrderStore((s) => s.authPending);
  const notice = useOrderStore((s) => s.authNotice);
  const savedName = useOrderStore((s) => s.signer);
  const readOnly = useOrderStore(isReadOnly);
  const [name, setName] = useState(savedName);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [askCreate, setAskCreate] = useState(false);

  if (pending) return <section className="panel login-panel muted">מתחבר…</section>;

  const cleanName = name.replace(/\s+/g, ' ').trim();
  const valid = cleanName.length >= 2 && /^\d{4}$/.test(pin);

  async function submit(create: boolean) {
    setBusy(true);
    setError('');
    try {
      const result = await login(cleanName, pin, create);
      setAskCreate(result === 'not_found');
    } catch (err) {
      setAskCreate(false);
      const left = err instanceof ApiError ? err.data.attemptsLeft : undefined;
      const msg = err instanceof Error ? err.message : String(err);
      setError(typeof left === 'number' ? `${msg} נותרו ${left} ניסיונות.` : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel login-panel">
      <h2>כניסה להזמנה</h2>
      <p className="muted">
        {readOnly
          ? 'הסבב סגור לשינויים. היכנסו כדי לצפות בהזמנה שלכם.'
          : 'בכניסה הראשונה בוחרים קוד בן 4 ספרות. עם אותו שם וקוד אפשר לחזור להזמנה מכל מכשיר.'}
      </p>
      {notice && <div className="status error">{notice}</div>}
      <form
        className="login-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) void submit(false);
        }}
      >
        <div className="field">
          <label htmlFor="loginName">שם המזמין</label>
          <input
            id="loginName"
            type="text"
            autoComplete="name"
            placeholder="למשל: כהן"
            maxLength={40}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setAskCreate(false);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="loginPin">קוד (4 ספרות)</label>
          <input
            id="loginPin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            className="pin-input"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, '').slice(0, 4));
              setAskCreate(false);
            }}
          />
        </div>
        <button type="submit" className="btn-primary" disabled={!valid || busy}>
          {busy ? 'רגע…' : 'כניסה'}
        </button>
      </form>
      {error && <div className="status error">{error}</div>}
      {askCreate && (
        <div className="notice" role="alertdialog">
          <span>
            {readOnly ? (
              <>
                לא נמצאה הזמנה בשם <bdi>{cleanName}</bdi> בסבב הזה.
              </>
            ) : (
              <>
                לא נמצאה הזמנה בשם <bdi>{cleanName}</bdi> בסבב הזה. לפתוח הזמנה חדשה עם הקוד שבחרתם?
              </>
            )}
          </span>
          {!readOnly && (
            <div className="notice-actions">
              <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void submit(true)}>
                פתיחת הזמנה חדשה
              </button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => setAskCreate(false)}>
                תיקון השם
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
