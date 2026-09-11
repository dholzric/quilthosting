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
  "kit-asset:paper-pieces/hero.webp": "Mulberry, rose, indigo and cream English paper-pieced rosettes in progress on a pale wood table",
  "kit-asset:blackbird-studio/hero.webp": "A monumental black and bone improvisational quilt with one acid-yellow line in a charcoal gallery",
  "kit-asset:blue-ridge-circle/hero.webp": "A blue and cream flying-geese quilt draped over a porch rail before misty mountain ridges",
  "kit-asset:sunroom-society/hero.webp": "A bright orange, pink, lilac and blue patchwork quilt spread across a sunroom table",
  "kit-asset:redwork-archive/hero.webp": "A white quilt with intricate red embroidered medallions on a textile conservation table",
  "kit-asset:quilt-show-edition/hero.webp": "Large colorful quilts suspended in a bright industrial exhibition gallery",
  "kit-asset:mending-circle/hero.webp": "Several pairs of hands tying and stitching a denim, rust and mustard charity quilt together",
  "kit-asset:pattern-house/hero.webp": "A modern geometric quilt beside pattern diagrams, a ruler and coordinated fabric swatches",
};
