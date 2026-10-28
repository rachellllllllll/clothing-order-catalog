import { noStoreJson, parsePin, readJsonBody } from './_auth.js';
import { errorResponse, HttpError } from './_drive.js';
import { authorize, loadResponse, login, parseLines, parseName, saveOrder } from './_orders.js';

/**
 * POST /api/order (JSON body; see OrderRequest in _types.ts)
 *   login  { round, name, pin, create? } → { order, round, token, pinSet? }
 *   load   (Bearer token)                → { order, round }
 *   save   (Bearer token) { lines, baseRev } → { order, round }   409 on conflict, 423 when locked
 *   submit (Bearer token) { lines, baseRev } → same, and marks this version as sent
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    switch (body.action) {
      case 'login':
        return noStoreJson(await login(body.round, parseName(body.name), parsePin(body.pin), body.create === true));
      case 'load':
        return noStoreJson(loadResponse(await authorize(request)));
      case 'save':
      case 'submit': {
        const session = await authorize(request);
        return noStoreJson(await saveOrder(session, parseLines(body.lines), body.baseRev, body.action === 'submit'));
      }
      default:
        throw new HttpError(400, 'Unknown action.');
    }
  } catch (err) {
    return errorResponse(err);
  }
}
