import { errorResponse, listRounds } from './_drive.js';
import { roundStates } from './_orders.js';
import type { RoundDto } from './_types.js';

/** GET /api/rounds → { rounds: RoundDto[] } (newest first, with lock/archive state) */
export async function GET(): Promise<Response> {
  try {
    const [rounds, states] = await Promise.all([listRounds(), roundStates()]);
    const body: { rounds: RoundDto[] } = {
      rounds: rounds.map((r) => ({
        id: r.id,
        name: r.name,
        createdTime: r.createdTime,
        locked: states.get(r.id)?.locked ?? false,
        archived: states.get(r.id)?.archived ?? false,
      })),
    };
    // Short CDN cache: a lock/archive change shows up within seconds (saves are checked on the server anyway).
    return Response.json(body, {
      headers: { 'Cache-Control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=60' },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
