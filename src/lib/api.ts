export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? 'Something went wrong. Please try again.');
  return data as T;
}

/** JSON request to the MotionForge API. The custom header is required by the server's CSRF check. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-requested-with': 'motionforge' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return parse<T>(res);
}

export async function uploadBinary(path: string, blob: Blob): Promise<void> {
  const res = await fetch(path, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'x-requested-with': 'motionforge', 'content-type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  await parse(res);
}

export const when = (seconds: number) => new Date(seconds * 1000).toLocaleString();
