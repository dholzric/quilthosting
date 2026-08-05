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

export const authRoutes = new Hono<{ Bindings: Env }>();

type UserRow = {
  id: string;
  email: string;
  password_hash: string | null;
  name: string | null;
};

// POST /api/auth/register
authRoutes.post("/register", async (c) => {
  const body = await c.req.json<{
    email: string;
    password: string;
    name?: string;
  }>();

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

  return c.json(
    {
      user: { id, email, name: body.name ?? null },
      token,
    },
    201
  );
});

// POST /api/auth/login
authRoutes.post("/login", async (c) => {
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

// POST /api/auth/magic-link
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

  // Auto-create user if they don't exist (common for members)
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

  // Short-lived token for magic link (15 min)
  const token = await signJwt(
    { sub: user.id, email: user.email, name: user.name ?? undefined },
    c.env.JWT_SECRET,
    60 * 15
  );

  const baseUrl = c.env.APP_URL || "http://localhost:8787";
  const loginUrl = `${baseUrl}/auth/verify?token=${token}${
    body.guildSlug ? `&slug=${body.guildSlug}` : ""
  }`;

  const guildName = body.guildSlug || "QuiltHosting";
  const { subject, html } = magicLinkEmail({ guildName, loginUrl });

  await sendEmail(c.env, {
    to: email,
    subject,
    html,
  });

  return c.json({
    message: "If that email exists, a login link has been sent.",
  });
});

// POST /api/auth/verify-magic
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

// GET /api/auth/me
authRoutes.get("/me", async (c) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const payload = await verifyJwt(header.slice(7), c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  const user = await first<UserRow>(
    c.env.DB.prepare(
      "SELECT id, email, name FROM users WHERE id = ?"
    ).bind(payload.sub)
  );

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({
    user: { id: user.id, email: user.email, name: user.name },
  });
});
