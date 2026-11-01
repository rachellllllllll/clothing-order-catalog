import { useState } from 'react';
import { ApiError, apiPost } from '../lib/api/client';
import type { Round } from '../lib/source/types';
import { SizesEditor } from './SizesEditor';

interface NewRoundFormProps {
  onCreated: (round: Round) => void;
  onCancel: () => void;
  onSignedOut: () => void;
}

/** A new round starts as a draft: products, images and prices are added in its catalog editor. */
export function NewRoundForm({ onCreated, onCancel, onSignedOut }: NewRoundFormProps) {
  const [name, setName] = useState('');
  const [sizes, setSizes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await apiPost<{ round: Round }>('/api/admin', { action: 'createRound', name: name.trim(), sizes });
      onCreated(res.round);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section className="panel new-round">
      <h2>סבב חדש</h2>
      <form onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor="newRoundName">שם הסבב</label>
          <input
            id="newRoundName"
            type="text"
            maxLength={80}
            placeholder="למשל: קיץ 2027 ילדים"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="field">
          <span className="field-label">מידות</span>
          <SizesEditor sizes={sizes} onChange={setSizes} />
          <span className="muted small">אפשר לשלב כמה סוגים (למשל תינוקות + ילדים), ולשנות גם אחר כך.</span>
        </div>
        <div className="admin-actions">
          <button type="submit" className="btn-primary" disabled={!name.trim() || busy}>
            {busy ? 'יוצר…' : 'יצירת הסבב'}
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
            ביטול
          </button>
        </div>
        <p className="muted small">הסבב נוצר כטיוטה — המזמינים לא יראו אותו עד שתפרסמו.</p>
      </form>
      {error && <div className="status error">{error}</div>}
    </section>
  );
}
