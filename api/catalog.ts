import { noStoreJson, requireAdmin } from './_auth.js';
import { readAppCatalog } from './_catalog.js';
import { errorResponse, excelDisplayName, listFolder, pickExcel, pickImages } from './_drive.js';
import { findRound } from './_rounds.js';

// Cached on Vercel's CDN: Drive is hit at most once a minute regardless of traffic.
const CACHE = { 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=600' };

/**
 * GET /api/catalog?round=<id>
 *   Drive round (Excel):  { round: { id, name }, excel: { name, modifiedTime }, images: [{ id, name }] }
 *   Admin-page round:     DocCatalogResponse (drafts: admin only)
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const round = await findRound(new URL(request.url).searchParams.get('round'), true);
    if (round.folder) {
      if (round.draft) {
        requireAdmin(request);
        const { rev: _rev, ...body } = await readAppCatalog(round.folder);
        return noStoreJson(body);
      }
      const { rev: _rev, ...body } = await readAppCatalog(round.folder);
      return Response.json(body, { headers: CACHE });
    }
    const files = await listFolder(round.id);
    const excel = pickExcel(files);
    return Response.json(
      {
        round: { id: round.id, name: round.name },
        excel: { name: excelDisplayName(excel), modifiedTime: excel.modifiedTime },
        images: pickImages(files).map((f) => ({ id: f.id, name: f.name })),
      },
      { headers: CACHE },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
