import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { securityHeaders } from "./securityHeaders";

function app() {
  const a = new Hono();
  a.use("*", securityHeaders);
  a.get("/plain", (c) => c.text("ok"));
  a.get("/embed", (c) => {
    c.header("Content-Security-Policy", "frame-ancestors *");
    return c.text("widget");
  });
  a.get("/immutable", () => new Response("x", { headers: { "X-Test": "1" } }));
  return a;
}

describe("securityHeaders", () => {
  it("sets nosniff, referrer, frame protection and HSTS on https", async () => {
    const res = await app().request("https://quilthosting.com/plain");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(await res.text()).toBe("ok");
  });

  it("does not send HSTS over plain http (local dev)", async () => {
    const res = await app().request("http://localhost:8787/plain");
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("leaves an explicit frame-ancestors policy alone (embeds)", async () => {
    const res = await app().request("https://quilthosting.com/embed");
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors *");
    expect(res.headers.get("X-Frame-Options")).toBeNull();
  });

  it("copies headers from responses with immutable headers", async () => {
    const res = await app().request("https://quilthosting.com/immutable");
    expect(res.headers.get("X-Test")).toBe("1");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
