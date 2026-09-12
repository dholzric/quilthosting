#!/usr/bin/env node
/**
 * kits:gallery — render every kit with the real site renderer into a local
 * HTML gallery you can browse in a browser. No Worker, no Playwright.
 *
 *   npm run kits:gallery              generate + serve at http://127.0.0.1:8791
 *   npm run kits:gallery -- --build   generate only
 *   npm run kits:gallery -- --port 9000
 *
 * Output: docs/kit-gallery/index.html plus one HTML file per kit page.
 * Regenerated on every run. Pattern-only imagery; sample events/levels/store
 * rows are injected so dynamic sections are not empty.
 */

import { createServer } from "node:http";
import { mkdirSync, writeFileSync, copyFileSync, cpSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GALLERY = path.join(ROOT, "docs", "kit-gallery");
const SITES = path.join(GALLERY, "sites");
const ASSETS = path.join(GALLERY, "_assets");
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const BUILD_ONLY = args.includes("--build");
const portArg = args.find((a, i) => a === "--port" && args[i + 1]) ? Number(args[args.indexOf("--port") + 1]) : 8791;
const PORT = Number.isFinite(portArg) && portArg > 0 ? portArg : 8791;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function isoInDays(n, hour = 18) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(hour, 30, 0, 0);
  return d.toISOString();
}

function sampleData(kit) {
  const city = kit.previewSeed.city;
  const name = kit.previewSeed.guildName;
  const shop = kit.audience === "business";
  return {
    profile: {
      description: kit.character,
      meeting_info: "on the second Tuesday of every month at 6:30 pm",
      location: city,
      email: "hello@example.com",
    },
    events: [
      {
        id: "ev-1",
        title: shop ? "Open studio hours" : "Monthly meeting",
        start_at: isoInDays(6),
        end_at: isoInDays(6, 21),
        location: city,
        description: shop ? `Walk-in time at ${name}.` : `Program night for ${name}.`,
        member_price_cents: 0,
        non_member_price_cents: shop ? 0 : 800,
        registration_open: 1,
        capacity: 40,
      },
      {
        id: "ev-2",
        title: shop ? "Workshop" : "Sew day",
        start_at: isoInDays(13, 10),
        end_at: isoInDays(13, 16),
        location: city,
        description: "Bring a project in progress.",
        member_price_cents: 2500,
        non_member_price_cents: 3500,
        registration_open: 1,
        capacity: 16,
      },
      {
        id: "ev-3",
        title: shop ? "Pickup day" : "Charity quilt work day",
        start_at: isoInDays(20, 9),
        end_at: isoInDays(20, 14),
        location: city,
        description: null,
        member_price_cents: 0,
        non_member_price_cents: 0,
        registration_open: 1,
        capacity: null,
      },
    ],
    levels: [
      {
        id: "lv-1",
        name: "Individual",
        description: "One member, newsletter, and member rates on workshops.",
        price_cents: 4500,
        duration_months: 12,
        renewal_type: "annual",
      },
      {
        id: "lv-2",
        name: "Household",
        description: "Two adults at the same address.",
        price_cents: 6500,
        duration_months: 12,
        renewal_type: "annual",
      },
      {
        id: "lv-3",
        name: "Student",
        description: "Full-time student, any age.",
        price_cents: 2000,
        duration_months: 12,
        renewal_type: "annual",
      },
    ],
    products: [
      { id: "pr-1", name: "Pattern booklet", price_cents: 1800, description: "Printed, 12 pages.", image_file_id: null, stock: 12 },
      { id: "pr-2", name: "Fat-quarter bundle", price_cents: 2800, description: "Eight prints, one palette.", image_file_id: null, stock: 6 },
      { id: "pr-3", name: "Guild pin", price_cents: 800, description: null, image_file_id: null, stock: 40 },
    ],
    posts: [
      { slug: "welcome", title: `Welcome to ${name}`, published_at: isoInDays(-12, 12), excerpt: `A note from ${name} in ${city}.` },
      { slug: "show-and-tell", title: "Show and tell recap", published_at: isoInDays(-5, 12), excerpt: "Three tops, a finished binding, and a baby quilt." },
    ],
    galleries: [{ slug: "recent", title: "Recent work", cover_photo_id: null, count: 8 }],
  };
}

function rewritePageHtml(html, pageSlugs) {
  let out = html
    .replaceAll('href="/qh-site.css"', 'href="../../_assets/qh-site.css"')
    .replaceAll('href="/qh-signature.css"', 'href="../../_assets/qh-signature.css"')
    .replaceAll('src="/qh-site.js"', 'src="../../_assets/qh-site.js"');
  out = out.replaceAll('src="/qh-signature.js"', 'src="../../_assets/qh-signature.js"');
  out = out.replaceAll('src="/kit-assets/', 'src="../../kit-assets/').replaceAll('srcset="/kit-assets/', 'srcset="../../kit-assets/').replaceAll(', /kit-assets/', ', ../../kit-assets/');
  out = out.replace(/href="\/"/g, 'href="home.html"');
  out = out.replace(/href="\/([a-z0-9-]+)"/g, (m, slug) => (pageSlugs.has(slug) ? `href="${slug}.html"` : m));
  return out;
}

async function loadRenderer() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const out = mkdtempSync(path.join(cacheDir, "qh-kit-gallery-"));
  const file = path.join(out, "gallery.mjs");
  await esbuild.build({
    stdin: {
      contents: `
export { KITS, kitDesign, kitSettingsJson, substitutePlaceholders } from "./src/lib/site/kits/index.ts";
export { resolveKitImagery } from "./src/lib/site/kits/apply.ts";
export { renderSitePage, buildMenu, readSettingsMenu } from "./src/lib/site/render.ts";
export { paletteById } from "./src/lib/site/design/palettes.ts";
export { typePairById } from "./src/lib/site/design/typePairs.ts";
export { deriveRoles, isDarkDesign } from "./src/lib/site/design/tokens.ts";
`,
      resolveDir: ROOT,
      sourcefile: "kits-gallery-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: file,
    packages: "external",
    external: ["cloudflare:*"],
    logLevel: "silent",
    absWorkingDir: ROOT,
  });
  const mod = await import(pathToFileURL(file).href);
  return { mod, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

function audienceLabel(a) {
  if (a === "business") return "Business";
  if (a === "both") return "Guild or business";
  return "Guild";
}

function indexHtml(cards) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>QuiltHosting kit gallery — ${cards.length} designs</title>
<style>
  :root { --ink:#1c1916; --muted:#5c564e; --line:#ddd6cb; --paper:#f6f1e8; --card:#fffdf8; --accent:#9b2c2c; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 "Segoe UI", system-ui, sans-serif; color: var(--ink); background: var(--paper); }
  header.bar { position: sticky; top: 0; z-index: 5; background: #fffdf8ee; backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); padding: 1rem 1.25rem; }
  header.bar h1 { margin: 0; font-size: 1.35rem; font-weight: 650; }
  header.bar p { margin: .25rem 0 0; color: var(--muted); font-size: .9rem; }
  .controls { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-top: .85rem; }
  .controls button { border: 1px solid var(--line); background: #fff; color: var(--ink); border-radius: 999px; padding: .28rem .75rem; cursor: pointer; font: inherit; }
  .controls button[aria-pressed="true"] { background: var(--ink); color: #fff; border-color: var(--ink); }
  .controls input { border: 1px solid var(--line); border-radius: 8px; padding: .35rem .6rem; font: inherit; min-width: 12rem; background: #fff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.1rem; padding: 1.25rem; }
  .card { display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; text-decoration: none; color: inherit; box-shadow: 0 1px 0 #fff inset, 0 8px 20px #1c191608; }
  .card:hover { border-color: #c4b8a6; }
  .preview { height: 210px; overflow: hidden; background: #efe8dc; position: relative; }
  .preview iframe { width: 1280px; height: 900px; border: 0; transform-origin: top left; pointer-events: none; position: absolute; top: 0; left: 0; }
  .meta { padding: .85rem 1rem 1rem; }
  .meta h2 { margin: 0; font-size: 1.05rem; }
  .row { display: flex; gap: .4rem; flex-wrap: wrap; margin: .35rem 0 .45rem; }
  .pill { font-size: .72rem; letter-spacing: .02em; text-transform: uppercase; border-radius: 999px; padding: .12rem .5rem; background: #efe8dc; color: var(--muted); }
  .swatches { display: flex; gap: 4px; margin: .35rem 0; }
  .swatches i { width: 14px; height: 14px; border-radius: 50%; border: 1px solid #0002; display: block; }
  .char { margin: 0; color: var(--muted); font-size: .88rem; }
  .empty { padding: 3rem 1.25rem; color: var(--muted); }
  footer.note { padding: 0 1.25rem 2rem; color: var(--muted); font-size: .85rem; }
</style>
</head>
<body>
<header class="bar">
  <h1>All site kits</h1>
  <p>${cards.length} designs rendered with the live QuiltHosting stylesheet. Click a card to open every page at desktop and phone width.</p>
  <div class="controls">
    <button type="button" data-filter="all" aria-pressed="true">All</button>
    <button type="button" data-filter="guild" aria-pressed="false">Guild</button>
    <button type="button" data-filter="business" aria-pressed="false">Business</button>
    <button type="button" data-filter="both" aria-pressed="false">Both</button>
    <input type="search" id="q" placeholder="Filter by name or palette" aria-label="Filter kits">
  </div>
</header>
<div class="grid" id="grid">
${cards.join("\n")}
</div>
<p class="empty" id="empty" hidden>No kits match that filter.</p>
<footer class="note">Generated by <code>npm run kits:gallery</code>. Sample events, dues, and shop items are filler so dynamic sections have something to show.</footer>
<script>
  const buttons = [...document.querySelectorAll("[data-filter]")];
  const q = document.getElementById("q");
  const empty = document.getElementById("empty");
  function apply() {
    const f = buttons.find((b) => b.getAttribute("aria-pressed") === "true")?.dataset.filter || "all";
    const term = (q.value || "").trim().toLowerCase();
    let n = 0;
    for (const card of document.querySelectorAll(".card")) {
      const aud = card.dataset.audience;
      const hay = card.dataset.hay;
      const okAud = f === "all" || aud === f || (f === "guild" && aud === "both");
      const okTerm = !term || hay.includes(term);
      const show = okAud && okTerm;
      card.hidden = !show;
      if (show) n++;
    }
    empty.hidden = n > 0;
  }
  for (const b of buttons) b.addEventListener("click", () => {
    for (const x of buttons) x.setAttribute("aria-pressed", String(x === b));
    apply();
  });
  q.addEventListener("input", apply);
  function sizePreviews() {
    for (const wrap of document.querySelectorAll(".preview")) {
      const iframe = wrap.querySelector("iframe");
      const scale = wrap.clientWidth / 1280;
      iframe.style.transform = "scale(" + scale + ")";
    }
  }
  sizePreviews();
  addEventListener("resize", sizePreviews);
</script>
</body>
</html>`;
}

function kitViewHtml(kit, pages, palette, pair, roles) {
  const tabs = pages
    .map(
      (p, i) =>
        `<button type="button" data-page="${esc(p.slug)}.html" aria-pressed="${i === 0 ? "true" : "false"}">${esc(p.title)}</button>`
    )
    .join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(kit.name)} — kit gallery</title>
<style>
  :root { --ink:#1c1916; --muted:#5c564e; --line:#ddd6cb; --paper:#f6f1e8; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 "Segoe UI", system-ui, sans-serif; color: var(--ink); background: var(--paper); }
  header { display: flex; flex-wrap: wrap; gap: .75rem 1.25rem; align-items: flex-start; justify-content: space-between; padding: .9rem 1.1rem; border-bottom: 1px solid var(--line); background: #fffdf8; position: sticky; top: 0; z-index: 4; }
  a.back { color: var(--ink); }
  h1 { margin: 0; font-size: 1.2rem; }
  .char { margin: .2rem 0 0; color: var(--muted); max-width: 42rem; }
  .swatches { display: flex; gap: 4px; margin-top: .4rem; }
  .swatches i { width: 14px; height: 14px; border-radius: 50%; border: 1px solid #0002; display: block; }
  .tools { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
  .tools button { border: 1px solid var(--line); background: #fff; border-radius: 999px; padding: .28rem .7rem; cursor: pointer; font: inherit; }
  .tools button[aria-pressed="true"] { background: var(--ink); color: #fff; border-color: var(--ink); }
  .stage { padding: 1rem; display: flex; justify-content: center; }
  .frame { background: #fff; border: 1px solid var(--line); box-shadow: 0 12px 40px #1c191614; overflow: hidden; }
  .frame.desk { width: min(1366px, 100%); height: calc(100vh - 8.5rem); }
  .frame.phone { width: 390px; height: min(844px, calc(100vh - 8.5rem)); border-radius: 18px; }
  iframe { width: 100%; height: 100%; border: 0; background: #fff; }
</style>
</head>
<body>
<header>
  <div>
    <a class="back" href="../index.html">All kits</a>
    <h1>${esc(kit.name)} <span style="color:var(--muted);font-weight:500;font-size:.9rem">${esc(kit.id)}</span></h1>
    <p class="char">${esc(kit.character)}</p>
    <p class="char">${esc(audienceLabel(kit.audience))} · ${esc(palette?.name || kit.defaults.palette)} · ${esc(pair?.name || kit.defaults.typePair)} · ${esc(kit.defaults.header.variant)} header · ${esc(kit.defaults.pattern?.id || "none")} pattern</p>
    <div class="swatches" aria-hidden="true">
      <i style="background:${esc(roles.bg)}"></i>
      <i style="background:${esc(roles.primary)}"></i>
      <i style="background:${esc(roles.accent)}"></i>
      <i style="background:${esc(roles.ink)}"></i>
    </div>
  </div>
  <div>
    <div class="tools" id="pages">${tabs}</div>
    <div class="tools" style="margin-top:.45rem">
      <button type="button" data-width="desk" aria-pressed="true">Desktop 1366</button>
      <button type="button" data-width="phone" aria-pressed="false">Phone 390</button>
    </div>
  </div>
</header>
<div class="stage"><div class="frame desk" id="frame"><iframe id="view" src="home.html" title="${esc(kit.name)}"></iframe></div></div>
<script>
  const frame = document.getElementById("frame");
  const view = document.getElementById("view");
  const pageBtns = [...document.querySelectorAll("#pages button")];
  const widthBtns = [...document.querySelectorAll("[data-width]")];
  for (const b of pageBtns) b.addEventListener("click", () => {
    for (const x of pageBtns) x.setAttribute("aria-pressed", String(x === b));
    view.src = b.dataset.page;
  });
  for (const b of widthBtns) b.addEventListener("click", () => {
    for (const x of widthBtns) x.setAttribute("aria-pressed", String(x === b));
    frame.className = "frame " + b.dataset.width;
  });
</script>
</body>
</html>`;
}

function cardHtml(kit, palette, pair, roles) {
  const hay = [kit.id, kit.name, kit.character, kit.defaults.palette, kit.defaults.typePair, audienceLabel(kit.audience)]
    .join(" ")
    .toLowerCase();
  return `<a class="card" href="sites/${esc(kit.id)}/index.html" data-audience="${esc(kit.audience)}" data-hay="${esc(hay)}">
  <div class="preview"><iframe src="sites/${esc(kit.id)}/home.html" loading="lazy" tabindex="-1" title="${esc(kit.name)} home"></iframe></div>
  <div class="meta">
    <h2>${esc(kit.name)}</h2>
    <div class="row"><span class="pill">${esc(audienceLabel(kit.audience))}</span><span class="pill">${esc(palette?.name || kit.defaults.palette)}</span><span class="pill">${esc(pair?.name || kit.defaults.typePair)}</span></div>
    <div class="swatches" aria-hidden="true"><i style="background:${esc(roles.bg)}"></i><i style="background:${esc(roles.primary)}"></i><i style="background:${esc(roles.accent)}"></i><i style="background:${esc(roles.ink)}"></i></div>
    <p class="char">${esc(kit.character)}</p>
  </div>
</a>`;
}

function serve(root, port) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };
  return createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(readFileSync(file));
  }).listen(port);
}

async function main() {
  const { mod, cleanup } = await loadRenderer();
  try {
    mkdirSync(ASSETS, { recursive: true });
    copyFileSync(path.join(ROOT, "public", "qh-site.css"), path.join(ASSETS, "qh-site.css"));
    copyFileSync(path.join(ROOT, "public", "qh-site.js"), path.join(ASSETS, "qh-site.js"));
    copyFileSync(path.join(ROOT, "public", "qh-signature.css"), path.join(ASSETS, "qh-signature.css"));
    copyFileSync(path.join(ROOT, "public", "qh-signature.js"), path.join(ASSETS, "qh-signature.js"));
    if (existsSync(SITES)) rmSync(SITES, { recursive: true, force: true });
    mkdirSync(SITES, { recursive: true });
    if (existsSync(path.join(ROOT, "public", "kit-assets"))) {
      cpSync(path.join(ROOT, "public", "kit-assets"), path.join(GALLERY, "kit-assets"), { recursive: true });
    }

    const cards = [];
    for (const kit of mod.KITS) {
      const design = mod.kitDesign(kit);
      const settingsObj = JSON.parse(mod.kitSettingsJson(kit));
      const data = sampleData(kit);
      settingsObj.profile = data.profile;
      if (kit.audience === "business") {
        settingsObj.business = { name: kit.previewSeed.guildName, city: kit.previewSeed.city, email: "hello@example.com" };
      }
      const settings_json = JSON.stringify(settingsObj);
      const tenantType = kit.audience === "business" ? "business" : "guild";
      const tenant = {
        name: kit.previewSeed.guildName,
        slug: `kit-${kit.id}`,
        settings_json,
        tenant_type: tenantType,
      };
      const vars = {
        guildName: kit.previewSeed.guildName,
        city: kit.previewSeed.city,
        meetingInfo: data.profile.meeting_info,
      };
      const pageSlugs = new Set(kit.pages.map((p) => p.slug));
      const menuPages = kit.pages.map((p) => ({
        slug: p.slug,
        title: p.title,
        nav_label: p.navLabel ?? null,
        show_in_nav: p.nav,
      }));
      const menu = mod.buildMenu(menuPages, mod.readSettingsMenu(settings_json), "");
      const dir = path.join(SITES, kit.id);
      mkdirSync(dir, { recursive: true });

      for (const page of kit.pages) {
        const sections = mod.resolveKitImagery(mod.substitutePlaceholders(page.sections, vars), kit);
        let html = mod.renderSitePage({
          tenant,
          page: { slug: page.slug === "home" ? "" : page.slug, title: page.title, sections, membersOnly: page.membersOnly },
          menu,
          baseUrl: "",
          host: "gallery.local",
          showPlatformCredit: true,
          design,
          data,
          imgUrl: (id) => `#img-${id}`,
          extraHead: '<meta name="robots" content="noindex">\n',
        });
        html = rewritePageHtml(html, pageSlugs);
        writeFileSync(path.join(dir, `${page.slug}.html`), html);
      }

      const palette = mod.paletteById(kit.defaults.palette);
      const pair = mod.typePairById(kit.defaults.typePair);
      const roles = mod.deriveRoles(design.palette.input, mod.isDarkDesign(design));
      writeFileSync(path.join(dir, "index.html"), kitViewHtml(kit, kit.pages, palette, pair, roles));
      cards.push(cardHtml(kit, palette, pair, roles));
      process.stdout.write(`  ${kit.id} (${kit.pages.length} pages)\n`);
    }

    writeFileSync(path.join(GALLERY, "index.html"), indexHtml(cards));
    console.log(`\nWrote ${path.relative(ROOT, path.join(GALLERY, "index.html"))} (${mod.KITS.length} kits)`);
  } finally {
    cleanup();
  }

  if (BUILD_ONLY) return;
  const root = GALLERY;
  serve(root, PORT);
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`\nGallery: ${url}`);
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
