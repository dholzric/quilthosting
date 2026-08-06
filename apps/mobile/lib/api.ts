import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";

const DEFAULT_API =
  (Constants.expoConfig?.extra?.apiUrl as string) || "https://quilthosting.com";

export type Session = {
  token: string;
  slug: string;
  mode: "member" | "admin";
  tenantId?: string;
};

const KEY = "qh_session_v1";

export async function getSession(): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export async function setSession(s: Session | null) {
  if (!s) await SecureStore.deleteItemAsync(KEY);
  else await SecureStore.setItemAsync(KEY, JSON.stringify(s));
}

export function apiBase(): string {
  return DEFAULT_API.replace(/\/$/, "");
}

export async function api<T = any>(
  path: string,
  opts: RequestInit & { token?: string; slug?: string } = {}
): Promise<T> {
  const session = await getSession();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string>),
  };
  const token = opts.token || session?.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.slug || session?.slug) {
    headers["X-Tenant-Slug"] = opts.slug || session!.slug;
  }
  // Site gate: for private preview, pass through if cookie not available —
  // mobile clients use API with Bearer; site gate may still require password
  // cookie for HTML only. API returns JSON 401 site access for unauthed.
  const res = await fetch(`${apiBase()}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error || res.statusText);
  return data as T;
}

/** Member magic-link request */
export async function requestMagicLink(slug: string, email: string) {
  return api(`/api/auth/magic-link`, {
    method: "POST",
    body: JSON.stringify({ email, slug, purpose: "portal" }),
  });
}

/** Admin password login (dev) or Google token handoff via deep link */
export async function adminLogin(email: string, password: string) {
  return api<{ token: string }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}
