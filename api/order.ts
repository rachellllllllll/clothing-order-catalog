import { noStoreJson, parsePin, readJsonBody } from './_auth.js';
import { errorResponse, HttpError } from './_drive.js';
import { parseName } from './_members.js';
import { authorize, loadResponse, login, openOrder, parseLines, saveOrder, signin } from './_orders.js';

/**
 * POST /api/order (JSON body; see OrderRequest in _types.ts)
 *   signin { name, pin }                → { name, token }   (name + code from the orderers list; token for `open`)
 *   open   (Bearer signin token) { round } → { order, round, token, created?, shortages? }   (token for the actions below)
 *   login  { round, name, pin } → same as open   (signin + open in one step)
 *   load   (Bearer token)                → { order, round, shortages? }   (shortages: locked/archived rounds)
 *   save   (Bearer token) { lines, baseRev } → { order, round }   409 on conflict, 423 when locked
 *   submit (Bearer token) { lines, baseRev } → same, and marks this version as sent
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    switch (body.action) {
      case 'signin':
        return noStoreJson(await signin(parseName(body.name), parsePin(body.pin)));
      case 'open':
        return noStoreJson(await openOrder(request, body.round));
      case 'login':
        return noStoreJson(await login(body.round, parseName(body.name), parsePin(body.pin)));
      case 'load':
        return noStoreJson(await loadResponse(await authorize(request)));
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
