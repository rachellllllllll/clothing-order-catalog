import { errorResponse } from './_drive.js';
import { listRoundDtos } from './_orders.js';
import type { RoundDto } from './_types.js';

/** GET /api/rounds → { rounds: RoundDto[] } (newest first, with lock/archive state; without drafts) */
export async function GET(): Promise<Response> {
  try {
    const body: { rounds: RoundDto[] } = { rounds: await listRoundDtos(false) };
    // Short CDN cache: a lock/archive change shows up within seconds (saves are checked on the server anyway).
    return Response.json(body, {
      headers: { 'Cache-Control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=60' },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
