import "server-only";

export const API_URL = process.env.API_URL ?? "http://localhost:4000";
export const TOKEN_COOKIE = "sb_token";
const DEFAULT_EMAIL = process.env.PERSONAL_ADMIN_EMAIL ?? "admin@sonicbold.test";
const DEFAULT_PASSWORD = process.env.PERSONAL_ADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? "sonicbold-demo";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API ${status}`);
  }
}

/** Personal workspace: the server opens the owner account without a sign-in screen. */
export async function getAutoToken(): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: DEFAULT_EMAIL, password: DEFAULT_PASSWORD }),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`Auto-login to ${API_URL}/api/auth/login failed: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { token?: string };
    return data.token ?? null;
  } catch (err) {
    console.error(`Auto-login error connecting to ${API_URL}:`, err);
    return null;
  }
}

/** Server-side API access for the personal agency workspace. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let token = (await getAutoToken()) ?? undefined;
  if (!token) throw new Error("Cannot open your personal workspace. Check that the API is running and the owner account is configured.");

  let res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: "no-store",
  });

  if (res.status === 401) {
    token = (await getAutoToken()) ?? undefined;
    if (token) {
      res = await fetch(`${API_URL}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        cache: "no-store",
      });
    }
  }


  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}
