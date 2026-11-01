import { readImage } from './_catalog.js';
import { errorResponse } from './_drive.js';

/**
 * GET /api/image?id=<Drive file id> — a product image of a round created on the admin page.
 * An image id never gets new content (a replaced image gets a new id), so it is cached for good on Vercel's CDN.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const { mime, data } = await readImage(new URL(request.url).searchParams.get('id'));
    return new Response(data, {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
