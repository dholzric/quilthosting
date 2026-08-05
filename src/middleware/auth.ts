import { createMiddleware } from "hono/factory";
import type { Env, TenantVariables } from "../types";
import { verifyJwt, extractBearer } from "../lib/auth";

export type AuthVariables = TenantVariables & {
  user: {
    id: string;
    email: string;
    name?: string;
  };
};

export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: AuthVariables;
}>(async (c, next) => {
  const token = extractBearer(c.req.header("Authorization"));
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
  c.set("user", {
    id: payload.sub,
    email: payload.email,
    name: payload.name,
  });
  await next();
});

export const optionalAuth = createMiddleware<{
  Bindings: Env;
  Variables: Partial<AuthVariables> & TenantVariables;
}>(async (c, next) => {
  const token = extractBearer(c.req.header("Authorization"));
  if (token) {
    const payload = await verifyJwt(token, c.env.JWT_SECRET);
    if (payload) {
      c.set("user", {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
      });
    }
  }
  await next();
});
