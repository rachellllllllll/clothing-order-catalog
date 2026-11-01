/**
 * All order rounds: folders of the shared Drive catalog (an Excel file + images, see _drive.ts)
 * and rounds created on the admin page (a JSON catalog, see _catalog.ts).
 */
import { listAppRounds } from './_catalog.js';
import { driveCatalogConfigured, HttpError, listRounds, validRoundId } from './_drive.js';
import { ordersConfigured, type AppFile } from './_google.js';

export interface RoundRef {
  id: string;
  name: string;
  createdTime: string;
  /** Created on the admin page (JSON catalog). */
  editable: boolean;
  /** Still being prepared — hidden from orderers. */
  draft: boolean;
  /** The round folder in קטלוג/ (editable rounds only). */
  folder?: AppFile;
}

export async function listAllRounds(includeDrafts: boolean): Promise<RoundRef[]> {
  const drive = driveCatalogConfigured();
  const app = ordersConfigured();
  if (!drive && !app) throw new HttpError(500, 'Drive is not configured on the server.');
  const [driveRounds, appRounds] = await Promise.all([drive ? listRounds() : [], app ? listAppRounds() : []]);
  const all: RoundRef[] = [
    ...driveRounds.map((r) => ({ id: r.id, name: r.name, createdTime: r.createdTime, editable: false, draft: false })),
    ...appRounds.map((f) => ({
      id: f.id,
      name: f.name,
      createdTime: f.createdTime,
      editable: true,
      draft: f.appProperties.draft === '1',
      folder: f,
    })),
  ];
  return all
    .filter((r) => includeDrafts || !r.draft)
    .sort((a, b) => b.createdTime.localeCompare(a.createdTime));
}

/** Resolves a round id sent by the client; only known rounds are accepted (drafts only with `includeDrafts`). */
export async function findRound(roundId: unknown, includeDrafts = false): Promise<RoundRef> {
  const id = validRoundId(roundId);
  const round = (await listAllRounds(includeDrafts)).find((r) => r.id === id);
  if (!round) throw new HttpError(404, 'Order round not found.');
  return round;
}

/** A round created on the admin page (drafts included). */
export async function findAppRound(roundId: unknown): Promise<RoundRef & { folder: AppFile }> {
  const id = validRoundId(roundId);
  const folder = ordersConfigured() ? (await listAppRounds()).find((f) => f.id === id) : undefined;
  if (!folder) throw new HttpError(404, 'הסבב לא נמצא, או שהקטלוג שלו לא נערך בממשק הניהול.', 'not_found');
  return {
    id: folder.id,
    name: folder.name,
    createdTime: folder.createdTime,
    editable: true,
    draft: folder.appProperties.draft === '1',
    folder,
  };
}
