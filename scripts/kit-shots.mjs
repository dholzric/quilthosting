#!/usr/bin/env node
/**
 * kit-shots — render every starter design and save the picture the Design
 * panel shows on its card.
 *
 *   npm run kits:shots            rebuild every shot
 *   npm run kits:shots -- --only heritage,prairie
 *
 * Output: public/kit-shots/<kit-id>.webp, served straight off the assets
 * binding.
 *
 * Why a real screenshot and not a drawing: the panel used to paint a
 * miniature from the palette's four colours, and 120 of those are nearly
 * impossible to tell apart — which is the whole job the card has to do. These
 * are the actual pages, rendered by the actual renderer.
 *
 * Needs Playwright with the msedge channel, which is a local tool rather than
 * a dependency of the Worker. Shots are committed, so CI and deploys never
 * run this; you run it when a kit's design changes, and the Design panel
 * falls back to the painted miniature for any kit whose shot is missing.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "kit-shots");
const PORT = 8894;
/** Wide enough to stay crisp on a 2x screen at the card's ~300px. */
const WIDTH = 640;
/** The Design panel loads all 120 at once, so one heavy shot is 120 heavy. */
const MAX_KB = 80;

const only = (() => {
  const i = process.argv.indexOf("--only");
  return i > -1 && process.argv[i + 1] ? new Set(process.argv[i + 1].split(",")) : null;
})();

const kitIds = readdirSync(path.join(ROOT, "src/lib/site/kits"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(path.join(ROOT, "src/lib/site/kits", f), "utf8")).id)
  .filter((id) => !only || only.has(id))
  .sort();

if (!kitIds.length) {
  console.error("No kits matched.");
  process.exit(1);
}

// Playwright is a local tool, not a dependency of the Worker, so it may live
// outside this repo. PLAYWRIGHT_DIR points at the node_modules that has it.
let chromium;
for (const spec of [
  "playwright",
  process.env.PLAYWRIGHT_DIR ? path.join(process.env.PLAYWRIGHT_DIR, "playwright") : null,
].filter(Boolean)) {
  try { ({ chromium } = require(spec)); break; } catch { /* try the next */ }
}
if (!chromium) {
  console.error(
    "Playwright not found. Either `npm i -D playwright && npx playwright install msedge`, " +
    "or point PLAYWRIGHT_DIR at a node_modules that already has it."
  );
  process.exit(1);
}

console.log(`Building the gallery for ${kitIds.length} design${kitIds.length === 1 ? "" : "s"}…`);
await run(process.execPath, [path.join(ROOT, "scripts", "kits-gallery.mjs"), "--build"]);

const server = spawn(process.execPath, [path.join(ROOT, "scripts", "kits-gallery.mjs"), "--port", String(PORT)], {
  cwd: ROOT,
  stdio: "ignore",
});
process.on("exit", () => server.kill());
await waitFor(`http://127.0.0.1:${PORT}/`);

mkdirSync(OUT, { recursive: true });
const sharp = require("sharp");
const browser = await chromium.launch({ channel: "msedge" });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 })).newPage();

const failed = [];
let bytes = 0;
for (const id of kitIds) {
  try {
    const res = await page.goto(`http://127.0.0.1:${PORT}/sites/${id}/home.html`, { waitUntil: "networkidle", timeout: 25000 });
    if (!res || res.status() !== 200) throw new Error(`HTTP ${res && res.status()}`);
    await page.waitForTimeout(250);
    const png = await page.screenshot();
    const webp = await sharp(png).resize({ width: WIDTH }).webp({ quality: 70 }).toBuffer();
    if (webp.length > MAX_KB * 1024) throw new Error(`${Math.round(webp.length / 1024)} kB exceeds the ${MAX_KB} kB cap`);
    writeFileSync(path.join(OUT, `${id}.webp`), webp);
    bytes += webp.length;
    process.stdout.write(".");
  } catch (err) {
    failed.push(`${id} (${err.message})`);
    process.stdout.write("x");
  }
}
process.stdout.write("\n");
await browser.close();
server.kill();

// Shots for kits that no longer exist are dead weight in every deploy.
if (!only) {
  const live = new Set(kitIds.map((id) => `${id}.webp`));
  for (const f of readdirSync(OUT).filter((f) => f.endsWith(".webp"))) {
    if (!live.has(f)) { rmSync(path.join(OUT, f)); console.log(`removed stale ${f}`); }
  }
}

console.log(`${kitIds.length - failed.length} shot(s), ${Math.round(bytes / 1024)} kB total, ${Math.round(bytes / 1024 / Math.max(1, kitIds.length - failed.length))} kB each.`);
if (failed.length) {
  console.error(`\nFailed: ${failed.join(", ")}`);
  process.exit(1);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: "ignore" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(args[0])} exited ${code}`))));
  });
}

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`gallery server did not start on ${url}`);
}
