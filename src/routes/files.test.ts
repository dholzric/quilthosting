// Same idiom as src/routes/pages.test.ts: dispatch through the exported
// `fileRoutes` app with a thin stand-in for requireAuth + tenantMiddleware,
// a keyword-routed fake D1, and a fake R2 bucket that records every put.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { fileRoutes, normalizeStoredContentType } from "./files";
import type { Env, Tenant, TenantVariables } from "../types";
import type { AuthVariables } from "../middleware/auth";

const TENANT_ID = "tenant-1";

type SeedFileRow = {
  id: string;
  tenant_id: string;
  r2_key: string;
  filename: string;
  content_type: string | null;
  size: number | null;
  created_at: string;
  width?: number | null;
  height?: number | null;
  variants_json?: string | null;
  focal_json?: string | null;
  alt?: string | null;
};

function buildApp(opts: { fileRows?: SeedFileRow[] } = {}) {
  const dbWrites: { sql: string; binds: unknown[] }[] = [];
  const r2Puts: { key: string; contentType: string | undefined; size: number }[] = [];
  const rows = opts.fileRows ?? [];
  // `SELECT … FROM files WHERE id = ? AND tenant_id = ?` -- the tenant_id
  // predicate is applied from the ACTUAL binds, so a route that dropped it
  // would start leaking foreign rows here too.
  const lookup = (sql: string, binds: unknown[]) => {
    if (!sql.includes("FROM files")) return [];
    if (sql.includes("WHERE id = ? AND tenant_id = ?")) {
      return rows.filter((r) => r.id === binds[0] && r.tenant_id === binds[1]);
    }
    if (sql.includes("WHERE tenant_id = ?")) return rows.filter((r) => r.tenant_id === binds[0]);
    return [];
  };
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              return lookup(sql, binds)[0] ?? null;
            },
            async all() {
              return { results: lookup(sql, binds) };
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

// ---------------------------------------------------------------------------
// Image variants, focal point, alt, list shape (phase 2 Task B)
// ---------------------------------------------------------------------------

const WEBP = padded([...Array.from("RIFF", (c) => c.charCodeAt(0)), 0x24, 0x00, 0x00, 0x00, ...Array.from("WEBP", (c) => c.charCodeAt(0))]);

const PHOTO: SeedFileRow = {
  id: "f1",
  tenant_id: TENANT_ID,
  r2_key: `${TENANT_ID}/f1/photo.png`,
  filename: "photo.png",
  content_type: "image/png",
  size: 1234,
  created_at: "2026-09-08T00:00:00.000Z",
};

function multipart(parts: Record<string, Uint8Array>): FormData {
  const fd = new FormData();
  for (const [name, bytes] of Object.entries(parts)) {
    fd.append(name, new Blob([bytes]), name);
  }
  return fd;
}

async function postVariants(
  parts: Record<string, Uint8Array>,
  opts: { fileRows?: SeedFileRow[]; headers?: Record<string, string>; fileId?: string; body?: BodyInit } = {}
) {
  const { app, env, dbWrites, r2Puts } = buildApp({ fileRows: opts.fileRows ?? [PHOTO] });
  const res = await app.request(
    `/${opts.fileId ?? "f1"}/variants`,
    { method: "POST", headers: opts.headers ?? {}, body: opts.body ?? multipart(parts) },
    env
  );
  return { res, dbWrites, r2Puts };
}

describe("POST /files/:fileId/variants", () => {
  it("stores every sniffed part under r2_key/w<w>.<ext> and records variants_json + dimensions", async () => {
    const { res, r2Puts, dbWrites } = await postVariants(
      { "w480.webp": WEBP, "w480.jpg": JPEG, "w960.webp": WEBP },
      { headers: { "X-Image-Width": "3000", "X-Image-Height": "2000" } }
    );
    expect(res.status).toBe(200);
    expect(r2Puts.map((p) => [p.key, p.contentType])).toEqual([
      [`${TENANT_ID}/f1/photo.png/w480.webp`, "image/webp"],
      [`${TENANT_ID}/f1/photo.png/w480.jpg`, "image/jpeg"],
      [`${TENANT_ID}/f1/photo.png/w960.webp`, "image/webp"],
    ]);
    const update = dbWrites.find((w) => w.sql.includes("UPDATE files"));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("variants_json = ?");
    expect(update!.sql).toContain("width = ?");
    expect(update!.sql).toContain("height = ?");
    // Tenant-scoped write.
    expect(update!.sql).toContain("WHERE id = ? AND tenant_id = ?");
    expect(update!.binds.slice(-2)).toEqual(["f1", TENANT_ID]);
    const variants = JSON.parse(update!.binds[0] as string) as { w: number; format: string; key: string; bytes: number }[];
    // Stored sorted by (w, format), not in upload order.
    expect(variants).toEqual([
      { w: 480, format: "jpeg", key: `${TENANT_ID}/f1/photo.png/w480.jpg`, bytes: 64 },
      { w: 480, format: "webp", key: `${TENANT_ID}/f1/photo.png/w480.webp`, bytes: 64 },
      { w: 960, format: "webp", key: `${TENANT_ID}/f1/photo.png/w960.webp`, bytes: 64 },
    ]);
    expect(update!.binds[1]).toBe(3000);
    expect(update!.binds[2]).toBe(2000);
    const body = (await res.json()) as { id: string; variants: unknown[]; width: number | null; height: number | null };
    expect(body.id).toBe("f1");
    expect(body.variants).toHaveLength(3);
    expect(body.width).toBe(3000);
    expect(body.height).toBe(2000);
  });

  it("merges with variants already stored (a second batch keeps the first)", async () => {
    const existing = [{ w: 1600, format: "jpeg", key: `${TENANT_ID}/f1/photo.png/w1600.jpg`, bytes: 10 }];
    const { res, dbWrites } = await postVariants(
      { "w480.webp": WEBP, "w1600.jpg": JPEG },
      { fileRows: [{ ...PHOTO, variants_json: JSON.stringify(existing), width: 3000, height: 2000 }] }
    );
    expect(res.status).toBe(200);
    const update = dbWrites.find((w) => w.sql.includes("UPDATE files"))!;
    const variants = JSON.parse(update.binds[0] as string) as { w: number; format: string; bytes: number }[];
    expect(variants.map((v) => `${v.w}.${v.format}`).sort()).toEqual(["1600.jpeg", "480.webp"]);
    // The re-uploaded 1600 JPEG replaced the old entry (new byte count).
    expect(variants.find((v) => v.w === 1600)!.bytes).toBe(64);
    // No dimension headers -> width/height are left alone.
    expect(update.sql).not.toContain("width = ?");
  });

  it("ignores dimension headers that are not positive integers <= 12000", async () => {
    for (const [w, h] of [
      ["20000", "100"],
      ["100", "0"],
      ["abc", "100"],
      ["1.5", "100"],
      ["-3", "100"],
      ["100", ""],
    ]) {
      const { res, dbWrites } = await postVariants({ "w480.webp": WEBP }, { headers: { "X-Image-Width": w, "X-Image-Height": h } });
      expect(res.status, `${w}x${h}`).toBe(200);
      const update = dbWrites.find((x) => x.sql.includes("UPDATE files"))!;
      expect(update.sql, `${w}x${h}`).not.toContain("width = ?");
      expect(update.sql, `${w}x${h}`).not.toContain("height = ?");
    }
  });

  it("rejects a part whose bytes are not the declared format (bad magic) with 415 and stores nothing", async () => {
    const { res, r2Puts, dbWrites } = await postVariants({ "w480.webp": PNG });
    expect(res.status).toBe(415);
    expect(r2Puts).toHaveLength(0);
    expect(dbWrites).toHaveLength(0);
  });

  it("rejects a name/format mismatch (JPEG bytes under .webp, WebP bytes under .jpg) with 415", async () => {
    expect((await postVariants({ "w480.webp": JPEG })).res.status).toBe(415);
    expect((await postVariants({ "w480.jpg": WEBP })).res.status).toBe(415);
    // A good part in the same body does not rescue a bad one: nothing is written.
    const { res, r2Puts } = await postVariants({ "w480.webp": WEBP, "w960.jpg": SVG });
    expect(res.status).toBe(415);
    expect(r2Puts).toHaveLength(0);
  });

  it("rejects a part name outside w{480,960,1600,2400}.{webp,jpg} with 400", async () => {
    expect((await postVariants({ "w500.webp": WEBP })).res.status).toBe(400);
    expect((await postVariants({ "original.png": PNG })).res.status).toBe(400);
    expect((await postVariants({ "w480.png": PNG })).res.status).toBe(400);
  });

  it("rejects a per-part size over 6 MB with 413", async () => {
    const big = new Uint8Array(6 * 1024 * 1024 + 1);
    big.set(WEBP.subarray(0, 12));
    const { res, r2Puts } = await postVariants({ "w2400.webp": big });
    expect(res.status).toBe(413);
    expect(r2Puts).toHaveLength(0);
  });

  it("rejects a total over 25 MB with 413", async () => {
    const five = new Uint8Array(5 * 1024 * 1024);
    five.set(WEBP.subarray(0, 12));
    const parts: Record<string, Uint8Array> = {};
    for (const n of ["w480.webp", "w960.webp", "w1600.webp", "w2400.webp"]) parts[n] = five;
    const fiveJ = new Uint8Array(5 * 1024 * 1024);
    fiveJ.set(JPEG.subarray(0, 12));
    parts["w480.jpg"] = fiveJ;
    parts["w960.jpg"] = fiveJ;
    const { res, r2Puts } = await postVariants(parts);
    expect(res.status).toBe(413);
    expect(r2Puts).toHaveLength(0);
  });

  it("404s for a file that belongs to another tenant, without writing anything", async () => {
    const { res, r2Puts } = await postVariants({ "w480.webp": WEBP }, { fileRows: [{ ...PHOTO, tenant_id: "other" }] });
    expect(res.status).toBe(404);
    expect(r2Puts).toHaveLength(0);
    expect((await postVariants({ "w480.webp": WEBP }, { fileRows: [] })).res.status).toBe(404);
  });

  it("415s when the original is not a raster image (no variants for a PDF)", async () => {
    const { res } = await postVariants({ "w480.webp": WEBP }, { fileRows: [{ ...PHOTO, content_type: "application/pdf" }] });
    expect(res.status).toBe(415);
  });

  it("400s on an empty or non-multipart body", async () => {
    expect((await postVariants({})).res.status).toBe(400);
    const { res } = await postVariants({}, { body: "not a form", headers: { "Content-Type": "text/plain" } });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /files/:fileId — focal point and alt text", () => {
  async function patch(body: unknown, fileRows: SeedFileRow[] = [PHOTO], fileId = "f1") {
    const { app, env, dbWrites } = buildApp({ fileRows });
    const res = await app.request(
      `/${fileId}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      env
    );
    return { res, dbWrites };
  }

  it("stores a valid focal point as focal_json", async () => {
    const { res, dbWrites } = await patch({ focal: [0.25, 0.75] });
    expect(res.status).toBe(200);
    const update = dbWrites.find((w) => w.sql.includes("UPDATE files"))!;
    expect(update.sql).toContain("focal_json = ?");
    expect(update.sql).not.toContain("alt = ?");
    expect(update.binds[0]).toBe("[0.25,0.75]");
    expect(update.sql).toContain("WHERE id = ? AND tenant_id = ?");
    expect(update.binds.slice(-2)).toEqual(["f1", TENANT_ID]);
    expect(await res.json()).toEqual({ ok: true, id: "f1", focal: [0.25, 0.75], alt: null });
  });

  it("stores alt text (trimmed) and clears it with null", async () => {
    const { res, dbWrites } = await patch({ alt: "  A log-cabin quilt in reds  " });
    expect(res.status).toBe(200);
    const update = dbWrites.find((w) => w.sql.includes("UPDATE files"))!;
    expect(update.sql).toContain("alt = ?");
    expect(update.binds[0]).toBe("A log-cabin quilt in reds");
    const cleared = await patch({ alt: null, focal: null }, [{ ...PHOTO, alt: "old", focal_json: "[0.1,0.1]" }]);
    expect(cleared.res.status).toBe(200);
    const u2 = cleared.dbWrites.find((w) => w.sql.includes("UPDATE files"))!;
    expect(u2.binds.slice(0, 2)).toEqual([null, null]);
    expect(await cleared.res.json()).toEqual({ ok: true, id: "f1", focal: null, alt: null });
  });

  it("rejects out-of-range, malformed, and oversize input with 400", async () => {
    for (const body of [
      { focal: [1.5, 0.5] },
      { focal: [0.5, -0.1] },
      { focal: [0.5] },
      { focal: ["0.5", 0.5] },
      { focal: "0.5,0.5" },
      { alt: "x".repeat(201) },
      { alt: 42 },
      {},
      { other: 1 },
    ]) {
      const { res, dbWrites } = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(dbWrites, JSON.stringify(body)).toHaveLength(0);
    }
  });

  it("404s for another tenant's file and 400s for the logo alias", async () => {
    expect((await patch({ focal: [0.5, 0.5] }, [{ ...PHOTO, tenant_id: "other" }])).res.status).toBe(404);
    expect((await patch({ focal: [0.5, 0.5] }, [PHOTO], "logo")).res.status).toBe(400);
  });
});

describe("GET /files — list shape", () => {
  it("includes width, height, focal, alt and has_variants", async () => {
    const { app, env } = buildApp({
      fileRows: [
        {
          ...PHOTO,
          width: 3000,
          height: 2000,
          focal_json: "[0.2,0.8]",
          alt: "Quilt",
          variants_json: JSON.stringify([{ w: 480, format: "webp", key: "k", bytes: 1 }]),
        },
        { ...PHOTO, id: "f2", filename: "doc.pdf", content_type: "application/pdf" },
        { ...PHOTO, id: "f3", tenant_id: "other" },
      ],
    });
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "f1",
      filename: "photo.png",
      content_type: "image/png",
      size: 1234,
      created_at: PHOTO.created_at,
      width: 3000,
      height: 2000,
      focal: [0.2, 0.8],
      alt: "Quilt",
      has_variants: true,
    });
    expect(rows[1]).toEqual({
      id: "f2",
      filename: "doc.pdf",
      content_type: "application/pdf",
      size: 1234,
      created_at: PHOTO.created_at,
      width: null,
      height: null,
      focal: null,
      alt: null,
      has_variants: false,
    });
  });
});
