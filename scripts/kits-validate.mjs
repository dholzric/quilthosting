#!/usr/bin/env node
/**
 * kits:validate — the gate for site kits (src/lib/site/kits/*.json).
 *
 *   npm run kits:validate                 validate every kit, then run the kit test suite
 *   npm run kits:validate -- --no-tests   validate only (fast; no vitest)
 *   npm run kits:validate -- heritage     validate one kit id
 *
 * How it loads TypeScript without a build step: the kit modules are bundled
 * on the fly with esbuild (already installed as wrangler's dependency) into a
 * temp ESM file, then imported. Node 22's --experimental-strip-types cannot
 * load this graph (it uses `import x from "./heritage.json"` without an import
 * attribute and imports routes/pages.ts for RESERVED_SLUGS), so bundling is
 * the compile-free path. The vitest run afterwards
 * (`npx vitest run src/lib/site/kits --reporter=dot`) is the same check the
 * CI test suite makes: schema.test.ts iterates every kit file, checks photo
 * assets and LICENSE.txt, and pins the Heritage reference kit's content.
 *
 * Exit code 1 when any kit reports issues or the tests fail.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KITS_DIR = path.join(ROOT, "src/lib/site/kits");
const require = createRequire(import.meta.url);

/**
 * Bundle src/lib/site/kits/index.ts and import it. The bundle keeps `zod`,
 * `hono`, etc. external, so it must live inside the repo (node_modules/.cache)
 * for Node to resolve them; it is deleted again by the returned cleanup().
 */
export async function loadKitModule() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const out = mkdtempSync(path.join(cacheDir, "qh-kits-"));
  const file = path.join(out, "kits.mjs");
  await esbuild.build({
    entryPoints: [path.join(KITS_DIR, "index.ts")],
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

async function main(args) {
  const runTests = !args.includes("--no-tests");
  const only = args.filter((a) => !a.startsWith("--"));
  const { mod, cleanup } = await loadKitModule();
  try {
    const files = readdirSync(KITS_DIR)
      .filter((f) => f.endsWith(".json"))
      .filter((f) => !only.length || only.includes(f.replace(/\.json$/, "")));
    if (!files.length) {
      console.error(`No kit files found in ${KITS_DIR}${only.length ? ` for ${only.join(", ")}` : ""}`);
      return 1;
    }
    let failed = 0;
    for (const file of files) {
      let raw;
      try {
        raw = JSON.parse(readFileSync(path.join(KITS_DIR, file), "utf8"));
      } catch (err) {
        console.log(`FAIL ${file}: not valid JSON (${err.message})`);
        failed++;
        continue;
      }
      const { kit, issues } = mod.validateKit(raw);
      if (raw && raw.id && `${raw.id}.json` !== file) {
        issues.push({ path: "id", message: `Kit id "${raw.id}" does not match the file name ${file}` });
      }
      const unregistered = kit && !mod.kitById(kit.id);
      if (issues.length || unregistered) {
        failed++;
        console.log(`FAIL ${file}: ${issues.length} issue${issues.length === 1 ? "" : "s"}`);
        for (const i of issues) console.log(`    ${i.path}: ${i.message}`);
        if (unregistered) console.log(`    KITS: "${kit.id}" is not in the registry -- add it to src/lib/site/kits/index.ts`);
      } else {
        const pages = kit.pages.map((p) => `${p.slug}(${p.sections.length})`).join(" ");
        console.log(`ok   ${file}: ${kit.name} -- ${kit.pages.length} pages: ${pages}`);
      }
    }
    if (failed) {
      console.log(`\n${failed} kit${failed === 1 ? "" : "s"} failed validation.`);
      return 1;
    }
    console.log(`\nAll ${files.length} kit${files.length === 1 ? "" : "s"} valid.`);
  } finally {
    cleanup();
  }

  if (!runTests) return 0;
  console.log("\nRunning the kit test suite (vitest)...");
  const r = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vitest", "run", "src/lib/site/kits", "--reporter=dot"],
    { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" }
  );
  return r.status ?? 1;
}

// Only run when executed directly (kits-preview.mjs imports loadKitModule).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
