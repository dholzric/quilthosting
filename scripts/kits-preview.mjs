#!/usr/bin/env node
/**
 * kits:preview — render every page of every kit with the real renderer and
 * screenshot it at desktop (1366) and phone (390) widths into
 * docs/kit-gallery/<kit>/<page>-<width>.png, plus docs/kit-gallery/index.html.
 *
 * Prerequisites (the script checks both and says which is missing):
 *
 *   1. A running local Worker with the sections renderer, e.g.
 *        npm run dev -- --port 8790
 *      or set QH_START_WORKER=1 and the script spawns `npx wrangler dev --port 8790`
 *      itself and stops it when done. Override the URL with QH_BASE
 *      (default http://localhost:8790). If .dev.vars sets SITE_ACCESS_PASSWORD
 *      the script signs in to the site gate with it (or with QH_SITE_PASSWORD).
 *
 *   2. Playwright is NOT a dependency of this repo. Point PLAYWRIGHT_PATH at a
 *      directory that has it installed, e.g. a scratchpad:
 *        mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright
 *        PLAYWRIGHT_PATH=/tmp/pw npm run kits:preview
 *      The browser channel defaults to Edge (PLAYWRIGHT_CHANNEL=msedge);
 *      set PLAYWRIGHT_CHANNEL=chromium to use Playwright's own download.
 *
 * How a kit is applied: kits are inserted straight into the local D1 database
 * (`wrangler d1 execute quilthosting-db --local`) as a throwaway tenant
 * `kit-<id>` with the rows `kitPageRows` / `kitSettingsJson` produce -- the
 * same rows guild creation will write once the kit picker lands. The tenant
 * is replaced on every run. Pages are then screenshotted at
 * /g/kit-<id>/<slug>. The kit modules are bundled with esbuild exactly as in
 * kits-validate.mjs (see its header for why).
 *
 * Usage:
 *   npm run kits:preview                 all kits
 *   npm run kits:preview -- heritage     one kit
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { loadKitModule } from "./kits-validate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GALLERY = path.join(ROOT, "docs/kit-gallery");
const BASE = (process.env.QH_BASE || "http://localhost:8790").replace(/\/$/, "");
const WIDTHS = [1366, 390];
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const SHELL = process.platform === "win32";

function sql(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function d1(statement) {
  const r = spawnSync(NPX, ["wrangler", "d1", "execute", "quilthosting-db", "--local", "--command", statement], {
    cwd: ROOT,
    encoding: "utf8",
    shell: SHELL,
  });
  if (r.status !== 0) throw new Error(`wrangler d1 execute failed:\n${r.stdout}\n${r.stderr}`);
}

function sitePassword() {
  if (process.env.QH_SITE_PASSWORD) return process.env.QH_SITE_PASSWORD;
  try {
    const m = readFileSync(path.join(ROOT, ".dev.vars"), "utf8").match(/^SITE_ACCESS_PASSWORD=(.*)$/m);
    return m ? m[1].trim().replace(/^"|"$/g, "") : "";
  } catch {
    return "";
  }
}

async function waitForWorker(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/robots.txt`);
      if (r.status < 500) return true;
    } catch {}
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT_PATH;
  if (!dir) {
    throw new Error(
      "PLAYWRIGHT_PATH is not set. Install playwright in a scratch directory and point PLAYWRIGHT_PATH at it (see the header of scripts/kits-preview.mjs)."
    );
  }
  const req = createRequire(path.join(path.resolve(dir), "package.json"));
  return req("playwright");
}

/** Insert (replacing) the throwaway tenant for a kit; returns its slug. */
function applyKit(mod, kit) {
  const now = new Date().toISOString();
  const slug = `kit-${kit.id}`;
  const id = `kit-preview-${kit.id}`;
  const tenant = {
    id,
    name: kit.previewSeed.guildName,
    city: kit.previewSeed.city,
    meetingInfo: "on the second Tuesday of every month at 6:30 pm",
  };
  const rows = mod.kitPageRows(kit, tenant, now);
  const stmts = [
    `DELETE FROM pages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${sql(slug)})`,
    `DELETE FROM tenants WHERE slug = ${sql(slug)}`,
    `INSERT INTO tenants (id, name, slug, plan, status, settings_json, trial_ends_at, domain_status, domain_error, created_at, updated_at)
     VALUES (${sql(id)}, ${sql(tenant.name)}, ${sql(slug)}, 'free', 'active', ${sql(mod.kitSettingsJson(kit))}, NULL, 'skipped', NULL, ${sql(now)}, ${sql(now)})`,
    ...rows.map(
      (r, i) =>
        `INSERT INTO pages (id, tenant_id, slug, title, content_json, blocks_json, page_type, show_in_nav, nav_label, is_members_only, published, sort_order, seo_title, seo_description, noindex, created_at, updated_at)
         VALUES (${sql(`${id}-p${i}`)}, ${sql(id)}, ${sql(r.slug)}, ${sql(r.title)}, ${sql(r.content_json)}, ${sql(r.blocks_json)}, 'page', ${r.show_in_nav}, ${sql(r.nav_label)}, ${r.is_members_only}, 1, ${r.sort_order}, NULL, NULL, 0, ${sql(r.created_at)}, ${sql(r.updated_at)})`
    ),
  ];
  d1(stmts.join(";\n"));
  return slug;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function galleryHtml(gallery, problems) {
  const kits = gallery
    .map(({ kit, shots }) => {
      const pages = kit.pages
        .map((p) => {
          const figs = WIDTHS.map((w) => {
            const shot = shots.find((s) => s.page === p.slug && s.width === w);
            return `<figure><img src="${esc(shot.file)}" alt="${esc(p.title)} at ${w}px"><figcaption>${w}px</figcaption></figure>`;
          }).join("");
          return `<h3>${esc(p.title)} <code>/${esc(p.slug)}</code></h3><div class="row">${figs}</div>`;
        })
        .join("");
      return `<h2 id="${esc(kit.id)}">${esc(kit.name)} <small>(${esc(kit.id)})</small></h2><p>${esc(kit.character)}</p>${pages}`;
    })
    .join("");
  const problemList = problems.length
    ? `<h2>Problems</h2><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
    : "<p>No HTTP errors, console errors, or horizontal overflow.</p>";
  return `<!doctype html><meta charset="utf-8"><title>Kit gallery</title>
<style>body{font:14px/1.5 system-ui;margin:2rem;background:#f6f4ef;color:#222}h2{margin-top:3rem}.row{display:grid;grid-template-columns:3fr 1fr;gap:1rem;align-items:start;margin-bottom:2rem}img{width:100%;border:1px solid #ccc;background:#fff}figcaption{font-size:12px;color:#555}</style>
<h1>Kit gallery</h1><p>Generated ${esc(new Date().toISOString())} by <code>npm run kits:preview</code>.</p>
${kits}
${problemList}
`;
}

async function main() {
  const pw = loadPlaywright();
  const { mod, cleanup } = await loadKitModule();
  let worker = null;
  try {
    const kits = mod.KITS.filter((k) => !only.length || only.includes(k.id));
    if (!kits.length) throw new Error(`No kits matched ${only.join(", ")}`);

    if (process.env.QH_START_WORKER === "1") {
      console.log("Starting wrangler dev on :8790...");
      worker = spawn(NPX, ["wrangler", "dev", "--port", "8790"], { cwd: ROOT, stdio: "ignore", shell: SHELL });
    }
    if (!(await waitForWorker())) {
      throw new Error(`No Worker answering at ${BASE}. Start one with "npm run dev -- --port 8790" or set QH_START_WORKER=1.`);
    }

    const browser = await pw.chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "msedge" });
    const context = await browser.newContext();
    const password = sitePassword();
    if (password) {
      const r = await context.request.post(`${BASE}/site-access`, { form: { password, return_to: "/" }, maxRedirects: 0 });
      if (r.status() >= 400) throw new Error(`Site gate rejected the password (${r.status()}). Set QH_SITE_PASSWORD.`);
    }

    const gallery = [];
    const problems = [];
    for (const kit of kits) {
      const slug = applyKit(mod, kit);
      const dir = path.join(GALLERY, kit.id);
      mkdirSync(dir, { recursive: true });
      const shots = [];
      for (const page of kit.pages) {
        const url = `${BASE}/g/${slug}${page.slug === "home" ? "" : "/" + page.slug}`;
        for (const width of WIDTHS) {
          const tab = await context.newPage({ viewport: { width, height: width > 600 ? 900 : 844 } });
          const errors = [];
          tab.on("console", (m) => m.type() === "error" && errors.push(m.text()));
          tab.on("pageerror", (e) => errors.push(String(e)));
          const res = await tab.goto(url, { waitUntil: "networkidle" });
          const overflow = await tab.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
          const file = path.join(dir, `${page.slug}-${width}.png`);
          await tab.screenshot({ path: file, fullPage: true });
          shots.push({ page: page.slug, width, file: path.relative(GALLERY, file).replace(/\\/g, "/") });
          if (!res || res.status() >= 400) problems.push(`${kit.id}/${page.slug}@${width}: HTTP ${res ? res.status() : "no response"}`);
          if (overflow) problems.push(`${kit.id}/${page.slug}@${width}: horizontal overflow`);
          for (const e of errors) problems.push(`${kit.id}/${page.slug}@${width}: console error: ${e}`);
          await tab.close();
        }
        console.log(`  ${kit.id}/${page.slug}`);
      }
      gallery.push({ kit, shots });
    }
    await browser.close();

    writeFileSync(path.join(GALLERY, "index.html"), galleryHtml(gallery, problems));
    console.log(`\nWrote ${path.relative(ROOT, path.join(GALLERY, "index.html"))}`);
    if (problems.length) {
      console.log(`\n${problems.length} problem(s):`);
      for (const p of problems) console.log("  " + p);
      return 1;
    }
    return 0;
  } finally {
    cleanup();
    if (worker) worker.kill();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message || err);
    process.exit(1);
  }
);
