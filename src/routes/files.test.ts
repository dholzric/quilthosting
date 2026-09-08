// Same idiom as src/routes/pages.test.ts: dispatch through the exported
// `fileRoutes` app with a thin stand-in for requireAuth + tenantMiddleware,
// a keyword-routed fake D1, and a fake R2 bucket that records every put.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { fileRoutes, normalizeStoredContentType } from "./files";
import type { Env, Tenant, TenantVariables } from "../types";
import type { AuthVariables } from "../middleware/auth";

const TENANT_ID = "tenant-1";

function buildApp() {
  const dbWrites: { sql: string; binds: unknown[] }[] = [];
  const r2Puts: { key: string; contentType: string | undefined; size: number }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              dbWrites.push({ sql, binds });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const files = {
    async put(key: string, bytes: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
      r2Puts.push({ key, contentType: opts?.httpMetadata?.contentType, size: bytes.byteLength });
    },
    async get() {
      return null;
    },
    async delete() {},
  };
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables & TenantVariables }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: TENANT_ID, slug: "guild", settings_json: "{}" } as Tenant);
    c.set("user", { id: "user-1", email: "a@b.com" });
    await next();
  });
  app.route("/", fileRoutes);
  const env = { DB: db, FILES: files } as unknown as Env;
  return { app, env, dbWrites, r2Puts };
}

function padded(head: number[], size = 64): Uint8Array {
  const out = new Uint8Array(size);
  out.set(head);
  return out;
}

const PNG = padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = padded([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');

async function upload(path: string, contentType: string, body: Uint8Array, filename?: string) {
  const { app, env, dbWrites, r2Puts } = buildApp();
  const url = filename ? `${path}?filename=${encodeURIComponent(filename)}` : path;
  const res = await app.request(
    url,
    { method: "POST", headers: { "Content-Type": contentType }, body },
    env
  );
  return { res, dbWrites, r2Puts };
}

describe("POST /files/logo — content sniffing", () => {
  it("rejects an SVG declared as image/svg+xml with 415 and stores nothing", async () => {
    const { res, r2Puts, dbWrites } = await upload("/logo", "image/svg+xml", SVG);
    expect(res.status).toBe(415);
    expect(r2Puts).toHaveLength(0);
    expect(dbWrites).toHaveLength(0);
  });

  it("rejects SVG bytes smuggled under a PNG content type", async () => {
    const { res, r2Puts } = await upload("/logo", "image/png", SVG);
    expect(res.status).toBe(415);
    expect(r2Puts).toHaveLength(0);
  });

  it("rejects SVG bytes with a leading XML declaration and BOM", async () => {
    const body = new TextEncoder().encode('\uFEFF<?xml version="1.0"?><svg><script>alert(1)</script></svg>');
    const { res } = await upload("/logo", "image/png", body);
    expect(res.status).toBe(415);
  });

  it("accepts a PNG whose magic bytes match the declared type and stores the sniffed type", async () => {
    const { res, r2Puts, dbWrites } = await upload("/logo", "image/png", PNG);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; logo_file_id: string };
    expect(body.ok).toBe(true);
    expect(r2Puts).toHaveLength(1);
    expect(r2Puts[0].contentType).toBe("image/png");
    expect(r2Puts[0].key.endsWith("/logo.png")).toBe(true);
    const insert = dbWrites.find((w) => w.sql.includes("INSERT INTO files"));
    expect(insert).toBeDefined();
    // bind order: id, tenant_id, r2_key, filename, content_type, ...
    expect(insert!.binds[4]).toBe("image/png");
  });

  it("accepts a JPEG declared as image/jpg (canonicalised to image/jpeg)", async () => {
    const { res, r2Puts } = await upload("/logo", "image/jpg", JPEG);
    expect(res.status).toBe(201);
    expect(r2Puts[0].contentType).toBe("image/jpeg");
    expect(r2Puts[0].key.endsWith("/logo.jpg")).toBe(true);
  });

  it("rejects a JPEG declared as PNG (declared type not backed by magic bytes)", async () => {
    const { res, r2Puts } = await upload("/logo", "image/png", JPEG);
    expect(res.status).toBe(415);
    expect(r2Puts).toHaveLength(0);
  });

  it("rejects bytes that are not any known raster image", async () => {
    const { res } = await upload("/logo", "image/png", padded([0x00, 0x01, 0x02, 0x03]));
    expect(res.status).toBe(415);
  });

  it("rejects a non-image content type with 400", async () => {
    const { res } = await upload("/logo", "text/html", PNG);
    expect(res.status).toBe(400);
  });

  it("rejects a JPEG declared as image/png while a JPEG declared as image/jpeg is fine", async () => {
    expect((await upload("/logo", "image/jpeg", JPEG)).res.status).toBe(201);
    expect((await upload("/logo", "image/png", JPEG)).res.status).toBe(415);
  });
});

describe("POST /files — generic upload content-type normalisation", () => {
  it("stores text/html as application/octet-stream", async () => {
    const { res, r2Puts, dbWrites } = await upload("/", "text/html; charset=utf-8", SVG, "evil.html");
    expect(res.status).toBe(201);
    expect(r2Puts[0].contentType).toBe("application/octet-stream");
    const insert = dbWrites.find((w) => w.sql.includes("INSERT INTO files"));
    expect(insert!.binds[4]).toBe("application/octet-stream");
  });

  it("stores image/svg+xml as application/octet-stream", async () => {
    const { r2Puts } = await upload("/", "image/svg+xml", SVG, "logo.svg");
    expect(r2Puts[0].contentType).toBe("application/octet-stream");
  });

  it("keeps an inert type", async () => {
    const { r2Puts } = await upload("/", "application/pdf", PNG, "doc.pdf");
    expect(r2Puts[0].contentType).toBe("application/pdf");
  });
});

describe("normalizeStoredContentType", () => {
  it("neutralises every active type", () => {
    for (const t of [
      "text/html",
      "TEXT/HTML; charset=utf-8",
      "application/xhtml+xml",
      "image/svg+xml",
      "text/xml",
      "application/xml",
      "application/rss+xml",
      "text/javascript",
      "application/javascript",
      "application/x-javascript",
      "application/ecmascript",
      "text/vbscript",
      "application/x-shockwave-flash",
      "application/x-httpd-php",
    ]) {
      expect(normalizeStoredContentType(t), t).toBe("application/octet-stream");
    }
  });

  it("keeps inert types, lower-cased and without parameters", () => {
    expect(normalizeStoredContentType("application/pdf")).toBe("application/pdf");
    expect(normalizeStoredContentType("Image/PNG; foo=bar")).toBe("image/png");
    expect(normalizeStoredContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(normalizeStoredContentType("")).toBe("application/octet-stream");
    expect(normalizeStoredContentType(null)).toBe("application/octet-stream");
  });
});
