import { toMoney } from '../lib/catalog/text';
import { loadLocalFolder } from '../lib/source/localFolder';
import { useCart, useExportOrder } from '../store/cartHooks';
import { useOrderStore } from '../store/orderStore';
import { FilterBar } from './FilterBar';

interface Props {
  allowLocalFolder: boolean;
}

export function ControlsPanel({ allowLocalFolder }: Props) {
  const status = useOrderStore((s) => s.status);
  const loading = useOrderStore((s) => s.loading);
  const signer = useOrderStore((s) => s.signer);
  const modelsCount = useOrderStore((s) => s.catalog?.groups.length ?? 0);
  const setSigner = useOrderStore((s) => s.setSigner);
  const loadSource = useOrderStore((s) => s.loadSource);
  const clearAll = useOrderStore((s) => s.clearAll);
  const { totals } = useCart();
  const { exportOrder, disabledReason } = useExportOrder();

  function onFolderPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length) void loadSource(() => loadLocalFolder(files));
  }

  function onClear() {
    if (window.confirm('האם לנקות את כל הכמויות?')) clearAll();
  }

  return (
    <section className="panel">
      <div className="controls">
        <div className="controls-row">
          {allowLocalFolder && (
            <div className="field">
              <label htmlFor="orderFolderInput">תיקייה מקומית (אקסל + תמונות)</label>
              <input
                id="orderFolderInput"
                type="file"
                multiple
                ref={(el) => el?.setAttribute('webkitdirectory', '')}
                onChange={onFolderPicked}
                disabled={loading}
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="signerInput">שם המזמין</label>
            <input
              id="signerInput"
              type="text"
              placeholder="למשל: רונית ד"
              value={signer}
              onChange={(e) => setSigner(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={!!disabledReason}
            title={disabledReason}
            onClick={exportOrder}
          >
            הורדת קובץ הזמנה
          </button>
          <button type="button" className="btn-secondary" disabled={totals.units === 0} onClick={onClear}>
            ניקוי כל הכמויות
          </button>
        </div>
        <span className="muted">ההזמנה נשמרת בדפדפן. בסיום – הורידו את קובץ ההזמנה ושלחו אותו אליי.</span>
      </div>

      <div className={'status' + (status.isError ? ' error' : '')}>{loading ? 'טוען קטלוג…' : status.message}</div>

      <div className="summary">
        <div className="box">
          <div className="t">דגמים</div>
          <div className="v">{modelsCount}</div>
        </div>
        <div className="box">
          <div className="t">יחידות בסל</div>
          <div className="v">{totals.units}</div>
        </div>
        <div className="box">
          <div className="t">סה"כ לתשלום</div>
          <div className="v">{toMoney(totals.amount)}</div>
        </div>
        <div className="box">
          <div className="t">יחידות ללא מחיר</div>
          <div className="v danger">{totals.unpricedUnits}</div>
        </div>
      </div>

      {modelsCount > 0 && <FilterBar />}
    </section>
  );
}
