import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

/**
 * Per-IP rate limit with two layers:
 *
 *  1. Cloudflare's native Rate Limiting binding (`RATE_LIMITER` in
 *     wrangler.toml) — atomic, so a concurrent burst cannot slip past the
 *     budget the way a read-then-write KV counter can. Its period is fixed
 *     (60s) so it acts as burst protection with `burstLimit` requests/min.
 *  2. The KV sliding window for the longer budget (`limit` per
 *     `windowSeconds`). KV is eventually consistent and non-atomic; it is the
 *     backstop, not the guarantee.
 *
 * Both layers fail OPEN on infrastructure errors (a KV/limiter outage must
 * not lock every guild out), except when `failClosed` is set — use that for
 * credential endpoints where denying is safer than allowing.
 */
export function rateLimit(opts: {
  keyPrefix: string;
  limit?: number;
  windowSeconds?: number;
  /** Requests per 60s allowed through the atomic limiter (default: limit). */
  burstLimit?: number;
  failClosed?: boolean;
}) {
  const limit = opts.limit ?? 20;
  const windowSeconds = opts.windowSeconds ?? 600;
  const burstLimit = opts.burstLimit ?? limit;

  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const ip =
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";
    const key = `rl:${opts.keyPrefix}:${ip}`;
    const tooMany = () =>
      c.json({ error: "Too many requests. Please try again later." }, 429, {
        "Retry-After": String(Math.min(windowSeconds, 60)),
      });

    const limiter = (c.env as Partial<{ RATE_LIMITER: RateLimit }>).RATE_LIMITER;
    if (limiter) {
      try {
        // The binding's own limit is configured in wrangler.toml; encode the
        // per-endpoint budget into the key so a tighter endpoint burns
        // through its share faster: N distinct sub-keys ≈ N × binding limit.
        const shards = Math.max(1, Math.ceil(burstLimit / RATE_LIMITER_BINDING_LIMIT));
        const shard = Math.floor(Math.random() * shards);
        const { success } = await limiter.limit({ key: `${key}:${shard}` });
        if (!success) return tooMany();
      } catch (e) {
        console.warn("rate limiter binding error", e);
        if (opts.failClosed) return tooMany();
      }
    }

    if (!c.env.KV) return next();
    try {
      const raw = await c.env.KV.get(key);
      const count = raw ? Number(raw) : 0;
      if (Number.isFinite(count) && count >= limit) return tooMany();
      await c.env.KV.put(key, String(count + 1), {
        expirationTtl: windowSeconds,
      });
    } catch (e) {
      console.warn("rate limit KV error", e);
      if (opts.failClosed) return tooMany();
    }
    await next();
  });
}

/** Must match `simple.limit` for RATE_LIMITER in wrangler.toml. */
export const RATE_LIMITER_BINDING_LIMIT = 10;
