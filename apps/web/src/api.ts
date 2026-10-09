export const API_UNAVAILABLE =
  "The local API is not reachable. Start it from the repository root with: uvicorn app.main:app --app-dir apps/api";

async function parse<T>(response: Response): Promise<T> {
  let body: { detail?: unknown; message?: unknown } | null = null;
  try {
    body = await response.json();
  } catch {
    // A dev-proxy error page (API stopped) or an empty body is not JSON.
    if (!response.ok) throw new Error(response.status >= 500 ? API_UNAVAILABLE : `Request failed: ${response.status}`);
    throw new Error("The API returned an unreadable response.");
  }
  if (!response.ok) {
    const detail = body?.detail ?? body?.message;
    throw new Error(typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : `Request failed: ${response.status}`);
  }
  return body as T;
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error(API_UNAVAILABLE);
  }
}

export async function getJson<T>(url: string): Promise<T> {
  return parse<T>(await request(url));
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  return parse<T>(await request(url, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body),
  }));
}


export async function postBinary<T>(url: string, body: Blob | ArrayBuffer): Promise<T> {
  return parse<T>(await request(url, {
    method: "POST",
    headers: {"Content-Type":"application/octet-stream"},
    body,
  }));
}
