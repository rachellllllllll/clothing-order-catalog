import { loadLocalFolder } from '../lib/source/localFolder';
import { useOrderStore } from '../store/orderStore';

interface Props {
  allowLocalFolder: boolean;
}

/** The local-folder picker (development) and the status line; hidden when neither has anything to show. */
export function ControlsPanel({ allowLocalFolder }: Props) {
  const status = useOrderStore((s) => s.status);
  const loading = useOrderStore((s) => s.loading);
  const loadSource = useOrderStore((s) => s.loadSource);
  const message = loading ? 'טוען קטלוג…' : status.message;

  function onFolderPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length) void loadSource(() => loadLocalFolder(files));
  }

  if (!allowLocalFolder && !message) return null;

  return (
    <section className="panel">
      {allowLocalFolder && (
        <div className="controls">
          <div className="controls-row">
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
          </div>
        </div>
      )}
      {message && <div className={'status' + (status.isError ? ' error' : '')}>{message}</div>}
    </section>
  );
}
