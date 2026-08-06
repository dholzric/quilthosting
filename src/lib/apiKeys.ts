import { generateId } from "./utils/id";

export async function hashApiKey(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a secret key; returns raw (show once) + prefix + hash. */
export async function mintApiKey(): Promise<{
  id: string;
  raw: string;
  prefix: string;
  hash: string;
}> {
  const id = generateId();
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const secret = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const raw = `qh_${secret}`;
  const prefix = raw.slice(0, 12);
  const hash = await hashApiKey(raw);
  return { id, raw, prefix, hash };
}

export function extractApiKey(
  authHeader: string | undefined,
  queryKey: string | undefined
): string | null {
  if (authHeader?.startsWith("Bearer qh_")) return authHeader.slice(7).trim();
  if (authHeader?.startsWith("Bearer ") && authHeader.includes("qh_")) {
    return authHeader.slice(7).trim();
  }
  if (queryKey?.startsWith("qh_")) return queryKey;
  return null;
}
