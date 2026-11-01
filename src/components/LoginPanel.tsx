import { useState } from 'react';
import { useOrderStore } from '../store/orderStore';
import { openOrder, signIn } from '../store/orderSync';

/** The name from the sign-in details the admin sent (`?name=`), if the link included it. */
function linkName(): string {
  return new URLSearchParams(window.location.search).get('name')?.slice(0, 40) ?? '';
}

/** Sign-in with the name and 6-digit code from the orderers list — the first screen, before the rounds. */
export function LoginPanel() {
  const notice = useOrderStore((s) => s.authNotice);
  const savedName = useOrderStore((s) => s.signer);
  const [name, setName] = useState(() => linkName() || savedName);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const cleanName = name.replace(/\s+/g, ' ').trim();
  const valid = cleanName.length >= 2 && /^\d{6}$/.test(pin);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await signIn(cleanName, pin);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section className="panel login-panel">
      <h2>כניסה</h2>
      <p className="muted">הכניסה למזמינים שברשימה בלבד. את השם והקוד (6 ספרות) מקבלים ממנהל ההזמנות.</p>
      {notice && <div className="status error">{notice}</div>}
      <form
        className="login-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) void submit();
        }}
      >
        <div className="field">
          <label htmlFor="loginName">שם</label>
          <input
            id="loginName"
            type="text"
            autoComplete="username"
            placeholder="כפי שמופיע בהודעה מהמנהל"
            maxLength={40}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError('');
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="loginPin">קוד (6 ספרות)</label>
          <input
            id="loginPin"
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            maxLength={6}
            className="pin-input"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, '').slice(0, 6));
              setError('');
            }}
          />
        </div>
        <button type="submit" className="btn-primary" disabled={!valid || busy}>
          {busy ? 'רגע…' : 'כניסה'}
        </button>
      </form>
      {error && <div className="status error">{error}</div>}
      <p className="muted login-help">שכחתם את הקוד? פנו למנהל ההזמנות ותקבלו קוד חדש.</p>
    </section>
  );
}

/** Shown while the signed-in member's order in the chosen round opens, or why it could not open. */
export function OrderOpening({ onBack }: { onBack?: () => void }) {
  const notice = useOrderStore((s) => s.authNotice);

  if (!notice) return <section className="panel login-panel muted">פותח את ההזמנה…</section>;
  return (
    <section className="panel login-panel">
      <div className="status error">{notice}</div>
      <div className="login-actions">
        <button type="button" className="btn-primary" onClick={() => void openOrder()}>
          נסו שוב
        </button>
        {onBack && (
          <button type="button" className="btn-secondary" onClick={onBack}>
            חזרה לבחירת סבב
          </button>
        )}
      </div>
    </section>
  );
}
