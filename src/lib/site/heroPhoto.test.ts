// The front page photo.
//
// A guild that has a photo of its own work wants it beside the home page
// headline. The only upload they could find was "Your own block" under Quilt
// pattern — which is a TEXTURE, repeated every 96px behind sections. Uploading
// a landscape photo there produced wallpaper, and (until the same release) did
// not render at all in the hero, because the hero's pattern path never looked
// at the uploaded file.
//
// So the photo is its own setting, and it stands in exactly where the
// generated quilt block would have been — never over a section's own image.
import { describe, it, expect } from "vitest";
import { renderSection } from "./sections/render";
import { fixtureContext } from "./sections/fixtures";
import { DEFAULT_STYLE } from "./sections/schema";
import { DEFAULT_DESIGN, siteDesignSchema } from "./design/tokens";
import type { Section } from "./sections/schema";
import type { SiteDesign } from "./design/tokens";

const PHOTO = "file-hero-photo";

function hero(variant: "split" | "image", imageId: string | undefined, heroPhoto?: string): string {
  const section = {
    type: "hero",
    variant,
    title: "Welcome",
    style: { ...DEFAULT_STYLE, imageId },
    id: "h",
  } as unknown as Section;
  const design: SiteDesign = {
    ...DEFAULT_DESIGN,
    heroPhoto: heroPhoto ? { fileId: heroPhoto } : undefined,
  };
  return renderSection(section, fixtureContext({ design }));
}

describe("front page photo", () => {
  it("replaces the generated block in a split hero", () => {
    const html = hero("split", "pattern:log-cabin", PHOTO);
    expect(html).toContain(PHOTO);
    // Not the tiled texture: a photo belongs in an <img>, sized and cropped.
    expect(html).not.toContain("qh-media--pattern");
    expect(html).toContain("<img");
  });

  it("fills an image hero that only had a block reference to show", () => {
    // This variant rendered nothing at all for a pattern ref.
    const without = hero("image", "pattern:log-cabin");
    expect(without).not.toContain("<img");
    expect(hero("image", "pattern:log-cabin", PHOTO)).toContain(PHOTO);
  });

  it("never displaces a section's own uploaded image", () => {
    const html = hero("split", "file-section-own", PHOTO);
    expect(html).toContain("file-section-own");
    expect(html).not.toContain(PHOTO);
  });

  it("leaves the quilt block alone when no photo is set", () => {
    const html = hero("split", "pattern:log-cabin");
    expect(html).toContain("qh-media--pattern");
    expect(html).not.toContain("<img");
  });

  it("is carried through the design schema the PATCH validates", () => {
    const parsed = siteDesignSchema.safeParse({ ...DEFAULT_DESIGN, heroPhoto: { fileId: PHOTO } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.heroPhoto?.fileId).toBe(PHOTO);
  });

  it("rejects a file id that is not a file id", () => {
    for (const bad of ["../../etc/passwd", "a".repeat(65), "has space"]) {
      expect(siteDesignSchema.safeParse({ ...DEFAULT_DESIGN, heroPhoto: { fileId: bad } }).success, bad).toBe(false);
    }
  });
});
