import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

/**
 * Simple KV sliding-window rate limit.
 * keyPrefix distinguishes endpoints; default 20 req / 10 minutes per IP.
 */
export function rateLimit(opts: {
  keyPrefix: string;
  limit?: number;
  windowSeconds?: number;
}) {
  const limit = opts.limit ?? 20;
  const windowSeconds = opts.windowSeconds ?? 600;

  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    if (!c.env.KV) return next();

    const ip =
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";
    const key = `rl:${opts.keyPrefix}:${ip}`;

    try {
      const raw = await c.env.KV.get(key);
      const count = raw ? Number(raw) : 0;
      if (Number.isFinite(count) && count >= limit) {
        return c.json(
          { error: "Too many requests. Please try again later." },
          429
        );
      }
      await c.env.KV.put(key, String(count + 1), {
        expirationTtl: windowSeconds,
      });
    } catch (e) {
      console.warn("rate limit KV error", e);
    }
    await next();
  });
}
