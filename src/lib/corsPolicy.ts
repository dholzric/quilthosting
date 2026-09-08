/**
 * Explicit CORS origin policy.
 *
 * Before this existed, `src/index.ts` reflected ANY Origin with
 * `credentials: true`. The API authenticates with bearer tokens (not
 * cookies) so reflection was not directly exploitable, but it would have
 * become a real hole the moment sessions moved to cookies, and it let any
 * third-party page make credentialed cross-origin calls in the meantime.
 *
 * Allowed:
 *   - the platform origin (APP_URL)
 *   - any subdomain of the platform host (guild subdomains)
 *   - native app shells (capacitor://, ionic://) and Expo dev hosts
 *   - localhost / 127.0.0.1 on any port when ENVIRONMENT=development
 *
 * Custom tenant domains do not need CORS: the public guild site and the
 * portal are served on that same host and call `/api/...` relatively.
 *
 * Returns the origin string to echo, or null to emit no CORS headers.
 */
export function allowedOrigin(
  origin: string | undefined | null,
  appUrl: string | undefined,
  environment: string | undefined
): string | null {
  if (!origin) return null;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return null;
  }
  const scheme = o.protocol;
  const host = o.hostname.toLowerCase();

  if (scheme === "capacitor:" || scheme === "ionic:") return origin;

  if (environment === "development") {
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
      return origin;
    }
  }

  if (scheme !== "https:" && scheme !== "http:") return null;

  let platformHost = "";
  try {
    platformHost = new URL(appUrl || "").hostname.toLowerCase();
  } catch {
    platformHost = "";
  }
  if (!platformHost) return null;

  if (host === platformHost) return origin;
  if (host.endsWith("." + platformHost)) return origin;
  return null;
}
