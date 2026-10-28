import { errorResponse, excelDisplayName, findRound, listFolder, pickExcel, pickImages } from './_drive.js';

/** GET /api/catalog?round=<folderId> → { round: { id, name }, excel: { name, modifiedTime }, images: [{ id, name }] } */
export async function GET(request: Request): Promise<Response> {
  try {
    const round = await findRound(new URL(request.url).searchParams.get('round'));
    const files = await listFolder(round.id);
    const excel = pickExcel(files);
    return Response.json(
      {
        round: { id: round.id, name: round.name },
        excel: { name: excelDisplayName(excel), modifiedTime: excel.modifiedTime },
        images: pickImages(files).map((f) => ({ id: f.id, name: f.name })),
      },
      {
        // Cached on Vercel's CDN: Drive is hit at most once a minute regardless of traffic.
        headers: { 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=600' },
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
