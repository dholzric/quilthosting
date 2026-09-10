import { describe, expect, it } from "vitest";
import { kitSchema } from "./schema";
import { kitDesign, kitPageRows } from "./apply";
import heritage from "./heritage.json";
import { renderSection } from "../sections/render";
import { parseSections } from "../sections/schema";
import { kitAssetUrl } from "../kitAssets";

describe("bundled kit photographs", () => {
  const kit = kitSchema.parse({
    ...heritage,
    imagery: [{ id: "studio", kind: "photo", alt: "A stitched linen quilt", src: "public/kit-assets/heritage/studio.webp" }],
    pages: [{ slug: "home", title: "Home", nav: false, sections: [
      { type: "hero", variant: "split", title: "Made by hand", style: { imageId: "studio" } },
      { type: "portfolio", items: [{ imageId: "studio", title: "Linen" }] },
    ] }],
  });

  it("resolves both section media and nested portfolio images when a kit is applied", () => {
    const rows = kitPageRows(kit, { id: "t1", name: "Our guild" }, "2026-09-10T12:00:00Z");
    const sections = JSON.parse(rows[0].blocks_json);
    expect(sections[0].style.imageId).toBe("kit-asset:heritage/studio.webp");
    expect(sections[1].items[0].imageId).toBe("kit-asset:heritage/studio.webp");
    expect(kit.pages[0].sections[0].style?.imageId).toBe("studio");
  });

  it("serves bundled media from platform assets with working responsive widths", () => {
    const section = parseSections([{ type: "hero", variant: "split", title: "Linen", style: { imageId: "kit-asset:heritage/studio.webp" } }]).sections[0];
    const html = renderSection(section, { slug: "test", design: kitDesign(kit), data: {}, baseUrl: "/g/test", imgUrl: (id) => `/tenant-file/${id}` });
    expect(html).toContain('/kit-assets/heritage/studio.webp');
    expect(html).toContain('/kit-assets/heritage/studio-480.webp 480w');
    expect(html).toContain('/kit-assets/heritage/studio-960.webp 960w');
    expect(html).not.toContain('/tenant-file/kit-asset:');
  });

  it("rejects traversal, arbitrary origins, and malformed bundled paths", () => {
    for (const ref of ["kit-asset:../secrets.webp", "kit-asset:linen/../../x.webp", "kit-asset:https://example.com/x.webp", "kit-asset:linen/%2e%2e.webp", 'kit-asset:linen/a.webp\"onerror=alert(1)']) {
      expect(kitAssetUrl(ref)).toBeNull();
      expect(parseSections([{ type: "hero", title: "Unsafe", style: { imageId: ref } }]).issues.length).toBeGreaterThan(0);
    }
    expect(kitAssetUrl("kit-asset:linen-journal/hero.webp", 2400)).toBe("/kit-assets/linen-journal/hero.webp");
    expect(kitAssetUrl("kit-asset:linen-journal/hero.jpg", 480)).toBe("/kit-assets/linen-journal/hero.jpg");
  });
});
