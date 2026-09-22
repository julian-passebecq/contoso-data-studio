async function parse<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.detail ?? body.message ?? `Request failed: ${response.status}`);
  }
  return body as T;
}

export async function getJson<T>(url: string): Promise<T> {
  return parse<T>(await fetch(url));
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  return parse<T>(await fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body),
  }));
}


export async function postBinary<T>(url: string, body: Blob | ArrayBuffer): Promise<T> {
  return parse<T>(await fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/octet-stream"},
    body,
  }));
}
