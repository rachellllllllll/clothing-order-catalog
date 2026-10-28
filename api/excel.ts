import { downloadExcel, errorResponse, findRound, listFolder, pickExcel, XLSX_MIME } from './_drive.js';

/**
 * GET /api/excel?round=<folderId>&v=<modifiedTime> → the round's catalog Excel file.
 * The file is always looked up inside a validated round folder (no file id from the client),
 * so this endpoint can't be used to proxy arbitrary Drive files.
 * `v` only busts the CDN cache when the file changes.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const round = await findRound(new URL(request.url).searchParams.get('round'));
    const excel = pickExcel(await listFolder(round.id));
    const data = await downloadExcel(excel);
    return new Response(data, {
      headers: {
        'Content-Type': XLSX_MIME,
        'Cache-Control': 'public, max-age=0, s-maxage=86400, stale-while-revalidate=600',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
