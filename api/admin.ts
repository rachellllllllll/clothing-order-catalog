import { adminLogin, clearAdminCookie, isAdmin, noStoreJson, readJsonBody, requireAdmin } from './_auth.js';
import { createAppRound, publishAppRound, readAppCatalog, saveAppCatalog, uploadImage } from './_catalog.js';
import { errorResponse, HttpError } from './_drive.js';
import { addMembers, deleteMember, listMembers, newCode, pastOrderers, updateMember } from './_members.js';
import { adminOrder, allOrders, deleteRound, listOrders, listRoundDtos, setRoundState, setShortages } from './_orders.js';
import { findAppRound } from './_rounds.js';

/** Image uploads are sent as base64 JSON; Vercel's request limit is 4.5 MB. */
const MAX_ADMIN_BODY = 4_400_000;

/**
 * POST /api/admin (JSON body; see AdminRequest in _types.ts). Every action except login/session
 * requires the HttpOnly admin cookie set by login.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request, MAX_ADMIN_BODY);
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
      case 'setShortages':
        return noStoreJson(await setShortages(body.round, body.changes));
      case 'rounds':
        return noStoreJson({ rounds: await listRoundDtos(true) });
      case 'createRound': {
        const folder = await createAppRound(body.name, body.sizes);
        const round = (await listRoundDtos(true)).find((r) => r.id === folder.id);
        return noStoreJson({ round });
      }
      case 'catalog':
        return noStoreJson(await readAppCatalog((await findAppRound(body.round)).folder));
      case 'saveCatalog':
        return noStoreJson(await saveAppCatalog((await findAppRound(body.round)).folder, body.catalog, body.rev, body.name));
      case 'uploadImage':
        return noStoreJson(await uploadImage((await findAppRound(body.round)).folder, body.data));
      case 'publishRound':
        await publishAppRound((await findAppRound(body.round)).folder);
        return noStoreJson({ ok: true });
      case 'deleteRound':
        return noStoreJson(await deleteRound(body.round));
      case 'members':
        return noStoreJson(await listMembers());
      case 'addMembers':
        return noStoreJson(await addMembers(body.members));
      case 'updateMember':
        return noStoreJson(await updateMember(body.id, { name: body.name, phone: body.phone, active: body.active }));
      case 'newCode':
        return noStoreJson(await newCode(body.id));
      case 'deleteMember':
        return noStoreJson(await deleteMember(body.id));
      case 'pastOrderers':
        return noStoreJson(await pastOrderers());
      default:
        throw new HttpError(400, 'Unknown action.');
    }
  } catch (err) {
    return errorResponse(err);
  }
}
