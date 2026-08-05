import type { Env } from "../../types";

export function db(env: Env) {
  return env.DB;
}

/** Helper for single-row queries */
export async function first<T>(
  stmt: D1PreparedStatement
): Promise<T | null> {
  const result = await stmt.first<T>();
  return result ?? null;
}

/** Helper for multi-row queries */
export async function all<T>(
  stmt: D1PreparedStatement
): Promise<T[]> {
  const result = await stmt.all<T>();
  return result.results ?? [];
}
