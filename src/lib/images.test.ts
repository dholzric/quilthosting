// Pure-unit tests for the image helpers: variant selection, srcset/sizes
// emission, focal point, and `serveImage` against a fake R2 bucket.
import { describe, it, expect } from "vitest";
import {
  ALLOWED_IMAGE_TYPES,
  VARIANT_WIDTHS,
  parseVariants,
  pickVariant,
  srcsetFor,
  sizesFor,
  parseFocal,
  focalToObjectPosition,
  serveImage,
  type ImageVariant,
  type ImageRow,
} from "./images";

const V = (w: number, format: "webp" | "jpeg"): ImageVariant => ({
  w,
  format,
  key: `t/f/orig.png/w${w}.${format === "webp" ? "webp" : "jpg"}`,
  bytes: w * 10,
});

const BOTH: ImageVariant[] = [V(480, "webp"), V(480, "jpeg"), V(960, "webp"), V(960, "jpeg"), V(1600, "webp"), V(1600, "jpeg")];
const JPEG_ONLY: ImageVariant[] = [V(480, "jpeg"), V(960, "jpeg")];
const WEBP_ONLY: ImageVariant[] = [V(480, "webp"), V(960, "webp")];

describe("parseVariants", () => {
  it("returns [] for null, blank, malformed, and non-array JSON", () => {
    expect(parseVariants(null)).toEqual([]);
    expect(parseVariants(undefined)).toEqual([]);
    expect(parseVariants("")).toEqual([]);
    expect(parseVariants("{nope")).toEqual([]);
    expect(parseVariants('{"w":480}')).toEqual([]);
  });

  it("keeps well-formed entries and drops malformed ones", () => {
    const json = JSON.stringify([
      V(480, "webp"),
      { w: "960", format: "webp", key: "k", bytes: 1 },
      { w: 960, format: "gif", key: "k", bytes: 1 },
      { w: 960, format: "jpeg", key: "", bytes: 1 },
      { w: 960, format: "jpeg", key: "k", bytes: -1 },
      { w: 0, format: "jpeg", key: "k", bytes: 1 },
      "junk",
    ]);
    expect(parseVariants(json)).toEqual([V(480, "webp")]);
  });

  it("exports the canonical variant widths", () => {
    expect([...VARIANT_WIDTHS]).toEqual([240, 480, 960, 1600, 2400]);
  });
});

describe("pickVariant", () => {
  it("returns null with no variants", () => {
    expect(pickVariant([], 480)).toBeNull();
    expect(pickVariant([])).toBeNull();
  });

  it.each([
    // [wantW, wantFormat, accept, expected w, expected format]
    [480, "webp", undefined, 480, "webp"], // exact
    [500, "webp", undefined, 960, "webp"], // nearest >=
    [960, "jpeg", undefined, 960, "jpeg"],
    [1601, "jpeg", undefined, 1600, "jpeg"], // larger than every variant -> largest
    [5000, "webp", undefined, 1600, "webp"],
    [1, "jpeg", undefined, 480, "jpeg"], // tiny -> smallest
    [undefined, "webp", undefined, 1600, "webp"], // no width -> largest
    [480, undefined, "image/avif,image/webp,*/*;q=0.8", 480, "webp"], // Accept negotiates webp
    [480, undefined, "image/png,image/*;q=0.8", 480, "jpeg"], // no webp in Accept -> jpeg
    [480, undefined, undefined, 480, "jpeg"], // no Accept at all -> jpeg
    [480, "jpeg", "image/webp", 480, "jpeg"], // explicit beats Accept
  ] as const)("w=%s f=%s accept=%s -> %s %s", (wantW, wantFormat, accept, w, format) => {
    const got = pickVariant(BOTH, wantW, wantFormat, accept);
    expect(got).not.toBeNull();
    expect(got!.w).toBe(w);
    expect(got!.format).toBe(format);
  });

  it("falls back to the other format when the wanted one is not stored", () => {
    expect(pickVariant(JPEG_ONLY, 480, "webp")).toEqual(V(480, "jpeg"));
    expect(pickVariant(WEBP_ONLY, 480, "jpeg")).toEqual(V(480, "webp"));
    expect(pickVariant(JPEG_ONLY, 480, undefined, "image/webp")).toEqual(V(480, "jpeg"));
  });

  it("accepts 'jpg' as an alias for jpeg and ignores unknown formats", () => {
    expect(pickVariant(BOTH, 480, "jpg" as unknown as "jpeg")!.format).toBe("jpeg");
    expect(pickVariant(BOTH, 480, "gif" as unknown as "jpeg", undefined)!.format).toBe("jpeg");
  });

  it("does not depend on the stored order", () => {
    const shuffled = [V(1600, "jpeg"), V(480, "webp"), V(960, "jpeg"), V(480, "jpeg"), V(960, "webp"), V(1600, "webp")];
    expect(pickVariant(shuffled, 500, "webp")!.w).toBe(960);
    expect(pickVariant(shuffled, 9999, "jpeg")!.w).toBe(1600);
  });
});

describe("srcsetFor / sizesFor", () => {
  it("emits one candidate per width, ascending, with the w descriptor", () => {
    const out = srcsetFor((w) => `/img/abc?w=${w}`, [960, 480, 1600]);
    expect(out).toBe("/img/abc?w=480 480w, /img/abc?w=960 960w, /img/abc?w=1600 1600w");
  });

  it("drops non-positive and duplicate widths and returns '' for none", () => {
    expect(srcsetFor((w) => `u${w}`, [480, 480, 0, -1, NaN])).toBe("u480 480w");
    expect(srcsetFor((w) => `u${w}`, [])).toBe("");
  });

  it("maps each section kind to a sizes hint", () => {
    expect(sizesFor("hero")).toBe("100vw");
    expect(sizesFor("split")).toBe("(max-width: 720px) 100vw, 50vw");
    expect(sizesFor("grid")).toBe("(max-width: 720px) 100vw, (max-width: 1100px) 50vw, 33vw");
    expect(sizesFor("single")).toBe("(max-width: 1100px) 100vw, 1100px");
  });
});

describe("parseFocal / focalToObjectPosition", () => {
  it("parses a [x, y] pair in 0..1 and rejects anything else", () => {
    expect(parseFocal("[0.25, 0.75]")).toEqual([0.25, 0.75]);
    expect(parseFocal("[0, 1]")).toEqual([0, 1]);
    expect(parseFocal(null)).toBeUndefined();
    expect(parseFocal("")).toBeUndefined();
    expect(parseFocal("nope")).toBeUndefined();
    expect(parseFocal("[1.5, 0.5]")).toBeUndefined();
    expect(parseFocal("[-0.1, 0.5]")).toBeUndefined();
    expect(parseFocal('["a", 0.5]')).toBeUndefined();
    expect(parseFocal("[0.5]")).toBeUndefined();
  });

  it("formats as CSS object-position percentages, centred by default", () => {
    expect(focalToObjectPosition(undefined)).toBe("50% 50%");
    expect(focalToObjectPosition([0.25, 0.75])).toBe("25% 75%");
    expect(focalToObjectPosition([0, 1])).toBe("0% 100%");
    expect(focalToObjectPosition([0.3333, 0.6666])).toBe("33% 67%");
    // Out-of-range input is clamped, never emitted raw.
    expect(focalToObjectPosition([2, -1])).toBe("100% 0%");
  });
});

// ---------------------------------------------------------------------------
// serveImage
// ---------------------------------------------------------------------------

function fakeBucket(objects: Record<string, string>) {
  const gets: string[] = [];
  const bucket = {
    async get(key: string) {
      gets.push(key);
      if (!(key in objects)) return null;
      return { body: new TextEncoder().encode(objects[key]) };
    },
  } as unknown as R2Bucket;
  return { bucket, gets };
}

function row(overrides: Partial<ImageRow> = {}): ImageRow {
  return {
    id: "f1",
    tenant_id: "t1",
    r2_key: "t1/f1/photo.png",
    content_type: "image/png",
    variants_json: null,
    width: null,
    height: null,
    ...overrides,
  };
}

const withVariants = row({
  variants_json: JSON.stringify(BOTH),
  width: 3000,
  height: 2000,
});

describe("serveImage", () => {
  it("serves the original with today's exact headers when there are no variants", async () => {
    const { bucket, gets } = fakeBucket({ "t1/f1/photo.png": "PNGBYTES" });
    const res = await serveImage({ FILES: bucket }, row(), new URL("https://g.test/img/f1?w=960"), "image/webp");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("PNGBYTES");
    expect(res!.headers.get("Content-Type")).toBe("image/png");
    expect(res!.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res!.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res!.headers.get("Vary")).toBeNull();
    expect(gets).toEqual(["t1/f1/photo.png"]);
  });

  it("returns null when the original object is missing", async () => {
    const { bucket } = fakeBucket({});
    expect(await serveImage({ FILES: bucket }, row(), new URL("https://g.test/img/f1"), undefined)).toBeNull();
  });

  it("returns null when the stored content type is not an allowed raster type (even with variants)", async () => {
    const { bucket, gets } = fakeBucket({ "t1/f1/evil.html": "<script>", [V(480, "webp").key]: "w" });
    for (const ct of ["text/html", "image/svg+xml", "application/octet-stream", null]) {
      const r = row({ r2_key: "t1/f1/evil.html", content_type: ct, variants_json: JSON.stringify(BOTH) });
      expect(await serveImage({ FILES: bucket }, r, new URL("https://g.test/img/f1?w=480&f=webp"), undefined), String(ct)).toBeNull();
    }
    expect(gets).toEqual([]);
  });

  it("picks the smallest variant >= ?w in the explicit ?f format (no Vary)", async () => {
    const { bucket, gets } = fakeBucket({ [V(960, "jpeg").key]: "JPEG960" });
    const res = await serveImage({ FILES: bucket }, withVariants, new URL("https://g.test/img/f1?w=700&f=jpeg"), "image/webp");
    expect(res!.headers.get("Content-Type")).toBe("image/jpeg");
    expect(await res!.text()).toBe("JPEG960");
    expect(res!.headers.get("Vary")).toBeNull();
    expect(res!.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res!.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(gets).toEqual([V(960, "jpeg").key]);
  });

  it("accepts f=jpg and f=webp", async () => {
    const { bucket } = fakeBucket({ [V(480, "jpeg").key]: "J", [V(480, "webp").key]: "W" });
    const j = await serveImage({ FILES: bucket }, withVariants, new URL("https://g.test/img/f1?w=480&f=jpg"), undefined);
    expect(j!.headers.get("Content-Type")).toBe("image/jpeg");
    const w = await serveImage({ FILES: bucket }, withVariants, new URL("https://g.test/img/f1?w=480&f=webp"), undefined);
    expect(w!.headers.get("Content-Type")).toBe("image/webp");
  });

  it("negotiates the format from Accept when ?f is omitted and says Vary: Accept", async () => {
    const { bucket } = fakeBucket({ [V(480, "webp").key]: "W", [V(480, "jpeg").key]: "J" });
    const webp = await serveImage({ FILES: bucket }, withVariants, new URL("https://g.test/img/f1?w=480"), "image/avif,image/webp,*/*");
    expect(webp!.headers.get("Content-Type")).toBe("image/webp");
    expect(await webp!.text()).toBe("W");
    expect(webp!.headers.get("Vary")).toBe("Accept");

    const jpeg = await serveImage({ FILES: bucket }, withVariants, new URL("https://g.test/img/f1?w=480"), "image/png,*/*;q=0.5");
    expect(jpeg!.headers.get("Content-Type")).toBe("image/jpeg");
    expect(await jpeg!.text()).toBe("J");
    expect(jpeg!.headers.get("Vary")).toBe("Accept");

    const none = await serveImage({ FILES: bucket }, withVariants, new URL("https://g.test/img/f1?w=480"), undefined);
    expect(none!.headers.get("Content-Type")).toBe("image/jpeg");
    expect(none!.headers.get("Vary")).toBe("Accept");
  });

  it("serves the largest variant when ?w is missing or garbage", async () => {
    const { bucket, gets } = fakeBucket({ [V(1600, "webp").key]: "BIG" });
    for (const q of ["", "?w=abc", "?w=-5", "?w=0", "?w=1.5"]) {
      gets.length = 0;
      const res = await serveImage({ FILES: bucket }, withVariants, new URL(`https://g.test/img/f1${q}`), "image/webp");
      expect(await res!.text(), q).toBe("BIG");
      expect(gets, q).toEqual([V(1600, "webp").key]);
    }
  });

  it("ignores an unknown ?f and negotiates instead", async () => {
    const { bucket } = fakeBucket({ [V(480, "webp").key]: "W" });
    const res = await serveImage({ FILES: bucket }, withVariants, new URL("https://g.test/img/f1?w=480&f=gif"), "image/webp");
    expect(res!.headers.get("Content-Type")).toBe("image/webp");
    expect(res!.headers.get("Vary")).toBe("Accept");
  });

  it("falls back to the original when the chosen variant object is missing from R2", async () => {
    const { bucket, gets } = fakeBucket({ "t1/f1/photo.png": "ORIG" });
    const res = await serveImage({ FILES: bucket }, withVariants, new URL("https://g.test/img/f1?w=480&f=webp"), undefined);
    expect(await res!.text()).toBe("ORIG");
    expect(res!.headers.get("Content-Type")).toBe("image/png");
    expect(gets).toEqual([V(480, "webp").key, "t1/f1/photo.png"]);
  });

  it("returns null when both the variant and the original are missing", async () => {
    const { bucket } = fakeBucket({});
    expect(await serveImage({ FILES: bucket }, withVariants, new URL("https://g.test/img/f1?w=480&f=webp"), undefined)).toBeNull();
  });

  it("treats malformed variants_json as no variants", async () => {
    const { bucket } = fakeBucket({ "t1/f1/photo.png": "ORIG" });
    const res = await serveImage({ FILES: bucket }, row({ variants_json: "{broken" }), new URL("https://g.test/img/f1?w=480"), "image/webp");
    expect(await res!.text()).toBe("ORIG");
    expect(res!.headers.get("Vary")).toBeNull();
  });

  it("never emits a Content-Type outside ALLOWED_IMAGE_TYPES", () => {
    expect(ALLOWED_IMAGE_TYPES.has("image/webp")).toBe(true);
    expect(ALLOWED_IMAGE_TYPES.has("image/jpeg")).toBe(true);
    expect(ALLOWED_IMAGE_TYPES.has("image/svg+xml")).toBe(false);
  });
});
