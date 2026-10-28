import { adminLogin, clearAdminCookie, isAdmin, noStoreJson, readJsonBody, requireAdmin } from './_auth.js';
import { errorResponse, HttpError } from './_drive.js';
import { adminOrder, allOrders, listOrders, resetPin, setRoundState } from './_orders.js';

/**
 * POST /api/admin (JSON body; see AdminRequest in _types.ts). Every action except login/session
 * requires the HttpOnly admin cookie set by login.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    switch (body.action) {
      case 'login':
        return noStoreJson({ ok: true }, { headers: { 'Set-Cookie': await adminLogin(body.password) } });
      case 'session':
        return noStoreJson({ admin: isAdmin(request) });
      case 'logout':
        return noStoreJson({ ok: true }, { headers: { 'Set-Cookie': clearAdminCookie } });
    }

    requireAdmin(request);
    switch (body.action) {
      case 'orders':
        return noStoreJson(await listOrders(body.round));
      case 'order':
        return noStoreJson(await adminOrder(body.round, body.fileId));
      case 'allOrders':
        return noStoreJson(await allOrders(body.round));
      case 'setRound':
        return noStoreJson(await setRoundState(body.round, { locked: body.locked, archived: body.archived }));
      case 'resetPin':
        return noStoreJson(await resetPin(body.round, body.fileId));
      default:
        throw new HttpError(400, 'Unknown action.');
    }
  } catch (err) {
    return errorResponse(err);
  }
}
