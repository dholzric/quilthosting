#!/usr/bin/env node
/**
 * photos:check — fetch every id in the stock library and report any that no
 * longer returns an image.
 *
 * The photographs are served from Unsplash's CDN rather than copied into the
 * repo, which is what keeps them free to store and resize. The cost of that is
 * that a photo withdrawn at source becomes a blank hero on every site using
 * it, and nothing in the build would notice. This is how we notice.
 */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lib/site/photos.ts", import.meta.url), "utf8");
const ids = [...src.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1]);
if (!ids.length) {
  console.error("No photo ids found in src/lib/site/photos.ts");
  process.exit(1);
}

const bad = [];
for (const id of ids) {
  const url = `https://images.unsplash.com/photo-${id}?w=240&q=80&fm=webp&fit=crop`;
  try {
    const res = await fetch(url, { method: "GET" });
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !type.startsWith("image/")) bad.push(`${id} -> ${res.status} ${type}`);
    process.stdout.write(res.ok && type.startsWith("image/") ? "." : "x");
  } catch (err) {
    bad.push(`${id} -> ${err.message}`);
    process.stdout.write("x");
  }
}
process.stdout.write("\n");

if (bad.length) {
  console.error(`\n${bad.length} of ${ids.length} photos no longer resolve:`);
  for (const b of bad) console.error("  " + b);
  console.error("\nReplace them in src/lib/site/photos.ts and docs/photo-credits.md.");
  process.exit(1);
}
console.log(`All ${ids.length} photos resolve.`);
