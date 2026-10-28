export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** POSTs JSON to one of the api/ functions; non-2xx answers throw ApiError with the server's message. */
export async function apiPost<T>(path: string, body: object, opts: { token?: string; keepalive?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      keepalive: opts.keepalive,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'אין חיבור לשרת.', 'offline');
  }
  const data = (await res.json().catch(() => null)) as (Record<string, unknown> & { error?: string; code?: string }) | null;
  if (!res.ok || !data) {
    throw new ApiError(res.status, data?.error || `שגיאת שרת (${res.status})`, data?.code, data ?? {});
  }
  return data as T;
}
