import { Hono } from "hono";
import type { Env } from "../types";
import { generateId } from "../lib/utils/id";
import { first } from "../lib/db";
import {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
} from "../lib/auth";
import { sendEmail, magicLinkEmail } from "../lib/email";
import { rateLimit } from "../middleware/rateLimit";

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
  const body = await c.req.json<{ email: string; guildSlug?: string }>();
  if (!body.email) {
    return c.json({ error: "email is required" }, 400);
  }
  const email = body.email.toLowerCase().trim();
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
       VALUES (?, ?, null, ?, ?)`
    )
      .bind(id, email, now, now)
      .run();
    user = { id, email, password_hash: null, name: null };
  }
  const token = await signJwt(
    { sub: user.id, email: user.email, name: user.name ?? undefined },
    c.env.JWT_SECRET,
    60 * 15
  );
  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  const loginUrl = `${baseUrl}/auth/verify?token=${token}${body.guildSlug ? `&slug=${body.guildSlug}` : ""}`;
  const guildName = body.guildSlug || "QuiltHosting";
  const { subject, html } = magicLinkEmail({ guildName, loginUrl });
  await sendEmail(c.env, { to: email, subject, html });
  return c.json({ message: "If that email exists, a login link has been sent." });
});

authRoutes.post("/verify-magic", async (c) => {
  const body = await c.req.json<{ token: string }>();
  if (!body.token) {
    return c.json({ error: "token is required" }, 400);
  }
  const payload = await verifyJwt(body.token, c.env.JWT_SECRET);
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
  const sig = await hmacHex(c.env.JWT_SECRET, `gstate:${ts}:${dest}:${slug}`);
  const state = `${ts}.${dest}.${slug}.${sig}`;
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

  const [ts, dest, slug, sig] = state.split(".");
  const expected = await hmacHex(c.env.JWT_SECRET, `gstate:${ts}:${dest}:${slug}`);
  if (!ts || sig !== expected || Date.now() - Number(ts) > 10 * 60 * 1000) {
    return fail("Sign-in expired, please try again");
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
