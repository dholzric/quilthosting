#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadKitModule } from "./kits-validate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "docs", "design-review");
const jsonFiles = readdirSync(path.join(ROOT, "src/lib/site/kits")).filter((name) => name.endsWith(".json")).sort();
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const bump = (record, key) => { record[key] = (record[key] || 0) + 1; };
const imageryKind = (image) => String(image.id || "").split(":")[0] || image.kind || "unknown";
const signature = (page) => page.sections.map((section) => `${section.type}:${section.variant || "default"}`).join("|");

const { mod, cleanup } = await loadKitModule();
try {
  const kits = mod.KITS;
  const sectionTypes = {}, variants = {}, imagery = {}, homeSignatures = {}, secondarySignatures = {};
  let pages = 0;
  for (const kit of kits) {
    pages += kit.pages.length;
    for (const image of kit.imagery) bump(imagery, imageryKind(image));
    for (const page of kit.pages) {
      bump(page.slug === "home" ? homeSignatures : secondarySignatures, signature(page));
      for (const section of page.sections) {
        bump(sectionTypes, section.type);
        bump(variants, `${section.type}:${section.variant || "default"}`);
      }
    }
  }
  const duplicates = (record) => Object.entries(record)
    .filter(([, count]) => count > 1)
    .map(([sequence, count]) => ({ sequence, count }))
    .sort((a, b) => b.count - a.count || a.sequence.localeCompare(b.sequence));
  const report = {
    generatedAt: new Date().toISOString(),
    revision: git("rev-parse", "HEAD"),
    dirtyPaths: git("status", "--short").split(/\r?\n/).filter(Boolean),
    packageVersion: pkg.version,
    inventory: {
      registeredKits: kits.length,
      diskKitFiles: jsonFiles.length,
      registryMatchesDisk: kits.length === jsonFiles.length && kits.every((kit) => jsonFiles.includes(`${kit.id}.json`)),
      pages,
      homePages: kits.filter((kit) => kit.pages.some((page) => page.slug === "home")).length,
      secondaryPages: kits.reduce((sum, kit) => sum + kit.pages.filter((page) => page.slug !== "home").length, 0),
      imageryReferences: Object.values(imagery).reduce((sum, count) => sum + count, 0),
    },
    sectionTypes: Object.fromEntries(Object.entries(sectionTypes).sort()),
    variants: Object.fromEntries(Object.entries(variants).sort()),
    imagery: Object.fromEntries(Object.entries(imagery).sort()),
    repetition: { home: duplicates(homeSignatures), secondary: duplicates(secondarySignatures) },
    kits: kits.map((kit, index) => ({ id: kit.id, audience: kit.audience, order: index, pages: kit.pages.length, imagery: kit.imagery.length })),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, "baseline-audit.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.inventory, null, 2));
  if (!report.inventory.registryMatchesDisk) process.exitCode = 1;
} finally {
  cleanup();
}
