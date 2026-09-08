import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { generateId } from "../lib/utils/id";
import { first } from "../lib/db";
import {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  issueMagicToken,
  consumeMagicToken,
  revokeAuthToken,
} from "../lib/auth";
import { sendEmail, magicLinkEmail } from "../lib/email";
import { rateLimit } from "../middleware/rateLimit";

// Re-exported so src/index.ts can mount the browser landing for emailed
// magic links: `app.get("/auth/verify", magicLinkLanding)`.
export { magicLinkLanding, consumeMagicToken, sweepAuthTokens } from "../lib/auth";

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.use("/magic-link", rateLimit({ keyPrefix: "magic", limit: 10, windowSeconds: 600 }));
authRoutes.use("/login", rateLimit({ keyPrefix: "login", limit: 30, windowSeconds: 600 }));
authRoutes.use("/register", rateLimit({ keyPrefix: "register", limit: 10, windowSeconds: 600 }));

type UserRow = {
  id: string;
  email: string;
  password_hash: string | null;
  name: string | null;
};

// Login methods the UI should offer
authRoutes.get("/config", (c) => {
  const google = Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET);
  return c.json({
    google,
    google_required: google && c.env.GOOGLE_AUTH_REQUIRED === "true",
  });
});

function passwordAuthDisabled(c: { env: Env }): boolean {
  return (
    c.env.GOOGLE_AUTH_REQUIRED === "true" &&
    Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET)
  );
}

authRoutes.post("/register", async (c) => {
  if (passwordAuthDisabled(c)) {
    return c.json({ error: "Password sign-in is disabled. Use Google sign-in." }, 403);
  }
  const body = await c.req.json<{ email: string; password: string; name?: string }>();
  if (!body.email || !body.password) {
    return c.json({ error: "email and password are required" }, 400);
  }
  if (body.password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }
  const email = body.email.toLowerCase().trim();
  const existing = await first(
    c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email)
  );
  if (existing) {
    return c.json({ error: "Email already registered" }, 409);
  }
  const id = generateId();
  const passwordHash = await hashPassword(body.password);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, email, passwordHash, body.name ?? null, now, now)
    .run();
  const token = await signJwt(
    { sub: id, email, name: body.name },
    c.env.JWT_SECRET
  );
  return c.json({ user: { id, email, name: body.name ?? null }, token }, 201);
});

authRoutes.post("/login", async (c) => {
  if (passwordAuthDisabled(c)) {
    return c.json({ error: "Password sign-in is disabled. Use Google sign-in." }, 403);
  }
  const body = await c.req.json<{ email: string; password: string }>();
  if (!body.email || !body.password) {
    return c.json({ error: "email and password are required" }, 400);
  }
  const email = body.email.toLowerCase().trim();
  const user = await first<UserRow>(
    c.env.DB.prepare(
      "SELECT id, email, password_hash, name FROM users WHERE email = ?"
    ).bind(email)
  );
  if (!user || !user.password_hash) {
    return c.json({ error: "Invalid email or password" }, 401);
  }
  const valid = await verifyPassword(body.password, user.password_hash);
  if (!valid) {
    return c.json({ error: "Invalid email or password" }, 401);
  }
  const token = await signJwt(
    { sub: user.id, email: user.email, name: user.name ?? undefined },
    c.env.JWT_SECRET
  );
  return c.json({
    user: { id: user.id, email: user.email, name: user.name },
    token,
  });
});

authRoutes.post("/magic-link", async (c) => {
  const body = await c.req.json<{ email: string; guildSlug?: string; dest?: string }>();
  if (!body.email) {
    return c.json({ error: "email is required" }, 400);
  }
  const email = body.email.toLowerCase().trim();
  const existing = await first<UserRow>(
    c.env.DB.prepare(
      "SELECT id, email, password_hash, name FROM users WHERE email = ?"
    ).bind(email)
  );
  // A brand-new address gets its user row only AFTER the email actually goes
  // out -- a failed send must not leave a half-created account behind.
  const user: UserRow = existing ?? {
    id: generateId(),
    email,
    password_hash: null,
    name: null,
  };
  // Issue the one-time token (purpose "magic", jti recorded in auth_tokens)
  // before sending so the link in the email is live the moment it lands.
  const { token, jti } = await issueMagicToken(c.env.DB, c.env.JWT_SECRET, user);
  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  const slug = (body.guildSlug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const loginUrl = `${baseUrl}/auth/verify?token=${token}${slug ? `&slug=${encodeURIComponent(slug)}` : ""}${body.dest === "app" ? "&dest=app" : ""}`;
  const guildName = slug || "QuiltHosting";
  const { subject, html } = magicLinkEmail({ guildName, loginUrl });
  const sent = await sendEmail(c.env, { to: email, subject, html });
  if (!sent.success) {
    // Service-wide outage (provider down / RESEND_API_KEY unset), not an
    // account-existence signal: every address gets the same 503.
    console.error("magic-link email failed", sent.error);
    await revokeAuthToken(c.env.DB, jti);
    return c.json(
      { error: "We couldn't send email right now. Please try again in a few minutes." },
      503
    );
  }
  if (!existing) {
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES (?, ?, null, ?, ?)`
    )
      .bind(user.id, email, now, now)
      .run();
  }
  return c.json({ message: "If that email exists, a login link has been sent." });
});

authRoutes.post("/verify-magic", async (c) => {
  const body = await c.req.json<{ token: string }>();
  if (!body.token) {
    return c.json({ error: "token is required" }, 400);
  }
  // Only a purpose:"magic" token that has never been used gets through; a
  // session token (or a second use of the same link) is rejected here.
  const payload = await consumeMagicToken(c.env.DB, body.token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "Invalid or expired link" }, 401);
  }
  const sessionToken = await signJwt(
    { sub: payload.sub, email: payload.email, name: payload.name },
    c.env.JWT_SECRET
  );
  return c.json({
    user: { id: payload.sub, email: payload.email, name: payload.name ?? null },
    token: sessionToken,
  });
});

authRoutes.get("/me", async (c) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const payload = await verifyJwt(header.slice(7), c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
  const user = await first<UserRow & { is_platform_admin?: number }>(
    c.env.DB.prepare(
      "SELECT id, email, name, is_platform_admin FROM users WHERE id = ?"
    ).bind(payload.sub)
  );
  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      is_platform_admin: !!(user.is_platform_admin),
    },
  });
});

// --- Google OAuth (shared client with quiltmap/createablock/quiltgen) ---

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * OAuth login-CSRF protection. The signed `state` alone proves WE minted it,
 * not that THIS browser started the flow -- an attacker could start a login
 * with their own Google account and get a victim's browser to complete it,
 * logging the victim into the attacker's account. So a random nonce is set
 * in an HttpOnly cookie on the browser that starts the flow, signed into the
 * state, and required to match on the callback.
 */
const OAUTH_COOKIE = "qh_oauth";
const OAUTH_COOKIE_PATH = "/api/auth/google";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function isLocalhost(reqUrl: string): boolean {
  try {
    const host = new URL(reqUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

function oauthStateSig(secret: string, ts: string, dest: string, slug: string, nonce: string) {
  return hmacHex(secret, `gstate:${ts}:${dest}:${slug}:${nonce}`);
}

// GET /api/auth/google — kick off the OAuth redirect
authRoutes.get("/google", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.json({ error: "Google sign-in not configured" }, 503);
  }
  const ts = Date.now().toString();
  // dest/slug ride along in the signed state so members return to the portal
  // dest rides in the signed state: admin (web), portal (web), app (native deep link)
  const destQ = c.req.query("dest");
  const dest = destQ === "portal" ? "portal" : destQ === "app" ? "app" : "admin";
  const slug = (c.req.query("slug") || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sig = await oauthStateSig(c.env.JWT_SECRET, ts, dest, slug, nonce);
  const state = `${ts}.${dest}.${slug}.${nonce}.${sig}`;
  setCookie(c, OAUTH_COOKIE, nonce, {
    path: OAUTH_COOKIE_PATH,
    httpOnly: true,
    secure: !isLocalhost(c.req.url),
    sameSite: "Lax",
    maxAge: OAUTH_STATE_TTL_MS / 1000,
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${c.env.APP_URL}/api/auth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString());
});

// GET /api/auth/google/callback — exchange code, find-or-create user, hand JWT to the admin UI
authRoutes.get("/google/callback", async (c) => {
  const fail = (msg: string) =>
    c.redirect(`/admin#gerror=${encodeURIComponent(msg)}`);

  const code = c.req.query("code");
  const state = c.req.query("state") || "";
  if (!code) return fail(c.req.query("error") || "Google sign-in was cancelled");

  const [ts, dest, slug, nonce, sig] = state.split(".");
  const cookieNonce = getCookie(c, OAUTH_COOKIE) || "";
  // Single-use either way: clear the nonce cookie before any outcome.
  deleteCookie(c, OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH });
  if (!ts || !nonce || !sig) {
    return fail("Sign-in expired, please try again");
  }
  const expected = await oauthStateSig(c.env.JWT_SECRET, ts, dest, slug, nonce);
  if (sig !== expected || Date.now() - Number(ts) > OAUTH_STATE_TTL_MS) {
    return fail("Sign-in expired, please try again");
  }
  // Login-CSRF: the browser completing the flow must be the one that started it.
  if (!cookieNonce || cookieNonce !== nonce) {
    return fail("Sign-in could not be verified for this browser, please try again");
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${c.env.APP_URL}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  const tok = (await tokenRes.json()) as { id_token?: string; error_description?: string };
  if (!tokenRes.ok || !tok.id_token) {
    console.error("Google token exchange failed", tok);
    return fail(tok.error_description || "Google sign-in failed");
  }

  // id_token came directly from Google over TLS; decode its payload
  let claims: { email?: string; email_verified?: boolean; name?: string };
  try {
    const seg = tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    claims = JSON.parse(atob(seg));
  } catch {
    return fail("Could not read Google profile");
  }
  if (!claims.email || claims.email_verified === false) {
    return fail("Google account has no verified email");
  }

  const email = claims.email.toLowerCase().trim();
  let user = await first<UserRow>(
    c.env.DB.prepare(
      "SELECT id, email, password_hash, name FROM users WHERE email = ?"
    ).bind(email)
  );
  if (!user) {
    const id = generateId();
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(id, email, claims.name ?? null, now, now)
      .run();
    user = { id, email, password_hash: null, name: claims.name ?? null };
  }

  const jwt = await signJwt(
    { sub: user.id, email: user.email, name: user.name ?? claims.name },
    c.env.JWT_SECRET
  );
  if (dest === "app") {
    // Native apps catch this via the registered URL scheme
    return c.redirect(
      `quilthosting://auth?token=${jwt}${slug ? `&slug=${encodeURIComponent(slug)}` : ""}`
    );
  }
  if (dest === "portal") {
    return c.redirect(
      `/portal${slug ? `?slug=${encodeURIComponent(slug)}` : ""}#ptoken=${jwt}`
    );
  }
  return c.redirect(`/admin#gtoken=${jwt}`);
});
