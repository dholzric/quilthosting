/** Bundled starter imagery lives on the same origin as the site assets.
 * WebP assets ship at 480, 960 and 1600px (the unsuffixed original).
 * Restrict paths to one kit directory and one filename; never tenant URLs.
 */
export const KIT_ASSET_PATH = "[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*\\.(?:webp|png|jpg|jpeg)";
const REF = new RegExp(`^kit-asset:(${KIT_ASSET_PATH})$`);

export function kitAssetUrl(ref: string, width = 1600): string | null {
  const match = REF.exec(ref);
  if (!match) return null;
  const path = match[1];
  if (path.endsWith(".webp") && width <= 960) {
    return `/kit-assets/${path.replace(/\.webp$/, `-${width <= 480 ? 480 : 960}.webp`)}`;
  }
  return `/kit-assets/${path}`;
}

/** Descriptions for decorative hero slots, which have no separate alt field. */
export const KIT_ASSET_ALT: Readonly<Record<string, string>> = {
  "kit-asset:linen-journal/hero.webp": "An oatmeal, ink and ochre star quilt draped over an oak worktable in a sunlit studio",
  "kit-asset:color-assembly/hero.webp": "A contemporary quilt of red, cobalt, butter yellow and pink geometric blocks on a gallery wall",
  "kit-asset:indigo-house/hero.webp": "Indigo and ivory patchwork with fine white running stitches, folded on a dark wooden workbench",
  "kit-asset:weekend-house/hero.webp": "A sunlit farmhouse sewing room with a communal oak table and terracotta and sage patchwork quilt",
};
